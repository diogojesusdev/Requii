const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const path = require('path');
const fsSync = require('fs');
const fs = require('fs/promises');
const https = require('https');
const axios = require('axios');
const yaml = require('yaml');
const { randomUUID } = require('crypto');

const ENVIRONMENTS_FILE = 'environments.json';
const WORKSPACE_METADATA_FILE = '.requii-workspace.json';
const WORKSPACE_STATE_FILE = 'workspaces-state.json';
const MANAGED_WORKSPACES_DIRECTORY = 'workspaces';
const DEFAULT_WORKSPACE_NAME = 'Requii Workspace';
const BASE_ENVIRONMENT_ID = 'env_base';
const BASE_ENVIRONMENT_NAME = 'Base Environment';
const BASE_ENVIRONMENT_PREFIX = '_BASE_ENV';
const INSOMNIA_RUNTIME_ENV_PREFIX = '__INSOMNIA_ENV__';
const WINDOWS_APP_ID = 'com.requii.app';
const MIN_ZOOM_LEVEL = -3;
const MAX_ZOOM_LEVEL = 8;
const INSECURE_HTTPS_AGENT = new https.Agent({ rejectUnauthorized: false });

app.commandLine.appendSwitch('ignore-certificate-errors');
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

function serializeWindowState(window) {
    return {
        isMaximized: window.isMaximized(),
        isMinimized: window.isMinimized(),
    };
}

function emitWindowState(window) {
    if (!window || window.isDestroyed()) {
        return;
    }

    window.webContents.send('window:state-changed', serializeWindowState(window));
}

function emitZoomChanged(window) {
    if (!window || window.isDestroyed()) {
        return;
    }

    window.webContents.send('window:zoom-changed', {
        zoomLevel: window.webContents.getZoomLevel(),
    });
}

function normalizeSlashes(input) {
    return input.replace(/\\/g, '/');
}

function cleanRelativePath(input) {
    if (!input || input === '.') {
        return '';
    }

    return normalizeSlashes(input).replace(/^\/+|\/+$/g, '');
}

function safeFileName(name) {
    const trimmed = String(name || 'Untitled Request').trim() || 'Untitled Request';
    return trimmed.replace(/[<>:"/\\|?*]+/g, '-').replace(/\s+/g, ' ').trim();
}

function sanitizeSegment(name) {
    return safeFileName(name).replace(/\.+$/g, '').trim() || 'New Folder';
}

function buildRequestFileName(name) {
    return `${safeFileName(name)}.json`;
}

function getFolderAncestors(folderPath) {
    const normalizedFolderPath = cleanRelativePath(folderPath);
    if (!normalizedFolderPath) {
        return [];
    }

    const segments = normalizedFolderPath.split('/').filter(Boolean);
    return segments.map((_, index) => segments.slice(0, index + 1).join('/'));
}

function uniqueStrings(values, limit = Number.POSITIVE_INFINITY) {
    const seen = new Set();
    const nextValues = [];

    for (const value of Array.isArray(values) ? values : []) {
        if (typeof value !== 'string') {
            continue;
        }

        const trimmed = value.trim();
        if (!trimmed || seen.has(trimmed)) {
            continue;
        }

        seen.add(trimmed);
        nextValues.push(trimmed);

        if (nextValues.length >= limit) {
            break;
        }
    }

    return nextValues;
}

function normalizeStringRecord(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return {};
    }

    return Object.fromEntries(
        Object.entries(value).filter(([key, entryValue]) => typeof key === 'string' && typeof entryValue === 'string' && key.trim()),
    );
}

function deepCloneValue(value) {
    if (Array.isArray(value)) {
        return value.map((item) => deepCloneValue(item));
    }

    if (isPlainObject(value)) {
        return Object.fromEntries(Object.entries(value).map(([key, entryValue]) => [key, deepCloneValue(entryValue)]));
    }

    return value;
}

function mergeDeepValues(baseValue, overrideValue) {
    if (!isPlainObject(baseValue) || !isPlainObject(overrideValue)) {
        return deepCloneValue(overrideValue);
    }

    const merged = { ...deepCloneValue(baseValue) };

    for (const [key, value] of Object.entries(overrideValue)) {
        merged[key] = key in merged ? mergeDeepValues(merged[key], value) : deepCloneValue(value);
    }

    return merged;
}

function defaultOAuth2() {
    return {
        grantType: 'client_credentials',
        accessTokenUrl: '',
        authorizationUrl: '',
        authorizationCode: '',
        redirectUri: '',
        clientId: '',
        clientSecret: '',
        scope: '',
        audience: '',
        resource: '',
        username: '',
        password: '',
        accessToken: '',
        tokenPrefix: 'Bearer',
        addTokenTo: 'request_header',
        tokenParameterName: 'Authorization',
        clientAuthentication: 'basic',
        state: '',
        codeVerifier: '',
    };
}

function normalizeAuthShape(auth) {
    const safeAuth = auth || { type: 'none' };
    return {
        type: safeAuth.type || 'none',
        bearerToken: safeAuth.bearerToken || '',
        username: safeAuth.username || '',
        password: safeAuth.password || '',
        oauth2: {
            ...defaultOAuth2(),
            ...(safeAuth.oauth2 || {}),
        },
    };
}

function serializeRequest(request) {
    return {
        id: request.id,
        name: request.name,
        order: Number.isFinite(request.order) ? request.order : 0,
        method: request.method,
        url: request.url,
        headers: Array.isArray(request.headers) ? request.headers : [],
        query_params: Array.isArray(request.query_params) ? request.query_params : [],
        body: normalizeBodyShape(request.body),
        auth: normalizeAuthShape(request.auth),
    };
}

function normalizeBodyShape(body) {
    const content = typeof body?.content === 'string' ? body.content : '';
    const normalizedType = String(body?.type || '').trim().toLowerCase();

    if (normalizedType === 'json' || normalizedType.includes('json')) {
        return {
            type: 'json',
            content,
        };
    }

    if (normalizedType === 'raw' || normalizedType === 'text' || normalizedType === 'xml' || normalizedType === 'form' || normalizedType === 'formdata' || normalizedType === 'multipart') {
        return {
            type: content ? 'raw' : 'none',
            content,
        };
    }

    if (!normalizedType || normalizedType === 'none') {
        return {
            type: content ? 'raw' : 'none',
            content,
        };
    }

    return {
        type: content ? 'raw' : 'none',
        content,
    };
}

function normalizeRequestPayload(request, filePath = '') {
    const relativeFilePath = cleanRelativePath(filePath);
    const hasExplicitPath = Object.prototype.hasOwnProperty.call(request, 'path');
    const explicitFolder = hasExplicitPath ? cleanRelativePath(request.path) : null;
    const derivedFolder = cleanRelativePath(path.posix.dirname(relativeFilePath));
    const relativeFolder = explicitFolder !== null ? explicitFolder : derivedFolder;

    return {
        id: request.id || randomUUID(),
        name: request.name || 'Untitled Request',
        order: Number.isFinite(request.order) ? request.order : 0,
        method: String(request.method || 'GET').toUpperCase(),
        url: request.url || '',
        headers: Array.isArray(request.headers) ? request.headers : [],
        query_params: Array.isArray(request.query_params) ? request.query_params : [],
        body: normalizeBodyShape(request.body),
        auth: normalizeAuthShape(request.auth),
        filePath: relativeFilePath,
        path: relativeFolder === '.' ? '' : relativeFolder,
    };
}

function defaultRequest(name = 'Untitled Request') {
    return {
        id: randomUUID(),
        name,
        order: Date.now(),
        method: 'GET',
        url: '',
        headers: [],
        query_params: [],
        body: {
            type: 'none',
            content: '',
        },
        auth: normalizeAuthShape({ type: 'none' }),
    };
}

function defaultEnvironments() {
    return {
        active_environment_id: 'env_default',
        base_environment: {
            id: BASE_ENVIRONMENT_ID,
            name: BASE_ENVIRONMENT_NAME,
            variables: {},
        },
        environments: [
            {
                id: 'env_default',
                name: 'Default',
                variables: {},
            },
        ],
    };
}

function normalizeEnvironmentEntry(environment, fallbackId, fallbackName) {
    const nextId = typeof environment?.id === 'string' && environment.id.trim() ? environment.id.trim() : fallbackId;
    const nextName = typeof environment?.name === 'string' && environment.name.trim() ? environment.name.trim() : fallbackName;

    return {
        id: nextId,
        name: nextName,
        variables: isPlainObject(environment?.variables) ? environment.variables : {},
    };
}

function normalizeEnvironmentsState(environmentsState) {
    const fallbackState = defaultEnvironments();
    const baseEnvironment = normalizeEnvironmentEntry(
        environmentsState?.base_environment,
        fallbackState.base_environment.id,
        fallbackState.base_environment.name,
    );
    const seenIds = new Set([baseEnvironment.id]);
    const normalizedEnvironments = (Array.isArray(environmentsState?.environments) ? environmentsState.environments : [])
        .map((environment, index) => normalizeEnvironmentEntry(
            environment,
            index === 0 ? 'env_default' : `env_${index + 1}`,
            environment?.name || `Environment ${index + 1}`,
        ))
        .filter((environment) => {
            if (!environment.id || seenIds.has(environment.id)) {
                return false;
            }

            seenIds.add(environment.id);
            return true;
        });

    if (normalizedEnvironments.length === 0) {
        normalizedEnvironments.push({
            id: 'env_default',
            name: 'Default',
            variables: {},
        });
    }

    const activeEnvironmentId = normalizedEnvironments.some((environment) => environment.id === environmentsState?.active_environment_id)
        ? environmentsState.active_environment_id
        : normalizedEnvironments[0].id;

    return {
        active_environment_id: activeEnvironmentId,
        base_environment: {
            ...baseEnvironment,
            id: BASE_ENVIRONMENT_ID,
            name: BASE_ENVIRONMENT_NAME,
        },
        environments: normalizedEnvironments,
    };
}

function defaultWorkspaceMetadata() {
    return {
        workspace_id: '',
        workspace_name: DEFAULT_WORKSPACE_NAME,
        folder_order: [],
        folders: [],
    };
}

function normalizeFolderRecord(record) {
    const folderId = typeof record?.id === 'string' ? record.id.trim() : '';
    const folderPath = cleanRelativePath(typeof record?.path === 'string' ? record.path : '');

    if (!folderId || !folderPath) {
        return null;
    }

    return {
        id: folderId,
        path: folderPath,
    };
}

function normalizeFolderRecords(records) {
    const seenIds = new Set();
    const seenPaths = new Set();
    const normalized = [];

    for (const record of Array.isArray(records) ? records : []) {
        const normalizedRecord = normalizeFolderRecord(record);
        if (!normalizedRecord) {
            continue;
        }

        if (seenIds.has(normalizedRecord.id) || seenPaths.has(normalizedRecord.path)) {
            continue;
        }

        seenIds.add(normalizedRecord.id);
        seenPaths.add(normalizedRecord.path);
        normalized.push(normalizedRecord);
    }

    return normalized;
}

function folderRecordsEqual(left, right) {
    if (left.length !== right.length) {
        return false;
    }

    return left.every((record, index) => record.id === right[index]?.id && record.path === right[index]?.path);
}

function synchronizeFolderRecords(folderPaths, folderRecords = []) {
    const recordByPath = new Map(normalizeFolderRecords(folderRecords).map((record) => [record.path, record]));

    return folderPaths
        .map((folderPath) => cleanRelativePath(folderPath))
        .filter(Boolean)
        .map((folderPath) => recordByPath.get(folderPath) || { id: randomUUID(), path: folderPath });
}

function remapFolderRecords(folderRecords, sourcePath, destinationPath) {
    const cleanSourcePath = cleanRelativePath(sourcePath);
    const cleanDestinationPath = cleanRelativePath(destinationPath);

    return normalizeFolderRecords(
        folderRecords.map((record) => {
            if (record.path === cleanSourcePath) {
                return { ...record, path: cleanDestinationPath };
            }

            if (record.path.startsWith(`${cleanSourcePath}/`)) {
                return {
                    ...record,
                    path: cleanRelativePath(`${cleanDestinationPath}${record.path.slice(cleanSourcePath.length)}`),
                };
            }

            return record;
        }),
    );
}

function pruneFolderRecords(folderRecords, targetPath) {
    const cleanTargetPath = cleanRelativePath(targetPath);
    if (!cleanTargetPath) {
        return [];
    }

    return normalizeFolderRecords(
        folderRecords.filter((record) => record.path !== cleanTargetPath && !record.path.startsWith(`${cleanTargetPath}/`)),
    );
}

function mergePreferredFolderOrder(preferredOrder = [], fallbackOrder = []) {
    return [...new Set([...preferredOrder, ...fallbackOrder].map((folderPath) => cleanRelativePath(folderPath)).filter(Boolean))];
}

function normalizeImportedFolderRecords(payload) {
    const explicitRecords = normalizeFolderRecords(payload?.folder_records);
    if (explicitRecords.length > 0) {
        return explicitRecords;
    }

    return (Array.isArray(payload?.folders) ? payload.folders : [])
        .map((folderPath) => cleanRelativePath(folderPath))
        .filter(Boolean)
        .map((folderPath) => ({ id: randomUUID(), path: folderPath }));
}

function buildImportedRequestRelativePath(request) {
    const normalized = normalizeRequestPayload(request, '');
    return cleanRelativePath(path.posix.join(normalized.path || '', buildRequestFileName(normalized.name)));
}

function defaultWorkspaceState() {
    return {
        active_workspace_id: '',
        workspace_ui_state_by_id: {},
    };
}

function defaultWorkspaceUiState() {
    return {
        open_request_ids: [],
        active_request_id: '',
        request_editor_tab_by_id: {},
        response_tab_by_id: {},
        expanded_folder_paths: [],
        tree_filter: '',
    };
}

function normalizeFolderExpansionPaths(paths) {
    return [...new Set((Array.isArray(paths) ? paths : [])
        .map((folderPath) => cleanRelativePath(typeof folderPath === 'string' ? folderPath : ''))
        .filter(Boolean))];
}

function normalizeWorkspaceUiState(uiState) {
    return {
        open_request_ids: uniqueStrings(uiState?.open_request_ids, 12),
        active_request_id: typeof uiState?.active_request_id === 'string' ? uiState.active_request_id : '',
        request_editor_tab_by_id: normalizeStringRecord(uiState?.request_editor_tab_by_id),
        response_tab_by_id: normalizeStringRecord(uiState?.response_tab_by_id),
        expanded_folder_paths: normalizeFolderExpansionPaths(uiState?.expanded_folder_paths),
        tree_filter: typeof uiState?.tree_filter === 'string' ? uiState.tree_filter : '',
    };
}

function normalizeWorkspaceUiStateById(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return {};
    }

    return Object.fromEntries(
        Object.entries(value)
            .filter(([workspaceId]) => typeof workspaceId === 'string' && workspaceId.trim())
            .map(([workspaceId, uiState]) => [workspaceId, normalizeWorkspaceUiState(uiState)]),
    );
}

function folderNameFromPath(folderPath) {
    return cleanRelativePath(folderPath).split('/').filter(Boolean).pop() || '';
}

function folderParentPath(folderPath) {
    const cleanPath = cleanRelativePath(folderPath);
    return cleanPath ? cleanRelativePath(path.posix.dirname(cleanPath)) : '';
}

function folderOrderEquals(left, right) {
    if (left.length !== right.length) {
        return false;
    }

    return left.every((value, index) => value === right[index]);
}

function orderFolderPaths(folderPaths, preferredOrder = []) {
    const normalizedPaths = [...new Set(folderPaths.map((folderPath) => cleanRelativePath(folderPath)).filter(Boolean))];
    const orderIndex = new Map<string, number>(
        preferredOrder
            .map((folderPath, index) => [cleanRelativePath(folderPath), index] as [string, number])
            .filter(([folderPath]) => Boolean(folderPath)),
    );
    const childrenByParent = new Map();

    for (const folderPath of normalizedPaths) {
        const parentPath = folderParentPath(folderPath);
        if (!childrenByParent.has(parentPath)) {
            childrenByParent.set(parentPath, []);
        }
        childrenByParent.get(parentPath).push(folderPath);
    }

    const ordered = [];

    function visit(parentPath) {
        const children = [...(childrenByParent.get(parentPath) || [])].sort((left, right) => {
            const leftIndex = orderIndex.has(left) ? (orderIndex.get(left) ?? Number.POSITIVE_INFINITY) : Number.POSITIVE_INFINITY;
            const rightIndex = orderIndex.has(right) ? (orderIndex.get(right) ?? Number.POSITIVE_INFINITY) : Number.POSITIVE_INFINITY;
            if (leftIndex !== rightIndex) {
                return leftIndex - rightIndex;
            }
            return left.localeCompare(right);
        });

        for (const child of children) {
            ordered.push(child);
            visit(child);
        }
    }

    visit('');
    return ordered;
}

function buildWorkspaceExportPayload(snapshot, metadata, selection = null) {
    const allFolders = Array.isArray(snapshot?.folders) ? snapshot.folders : [];
    const allRequests = Array.isArray(snapshot?.requests) ? snapshot.requests : [];
    const folderRecords = normalizeFolderRecords(metadata?.folders || []);
    const normalizedSelection = selection && typeof selection === 'object' ? selection : null;
    const hasSelection = Boolean(normalizedSelection);
    const includeEnvironments = normalizedSelection?.includeEnvironments !== false;
    const selectedFolderPathSet = new Set(uniqueStrings(normalizedSelection?.folderPaths || []).filter((folderPath) => allFolders.includes(folderPath)));
    const selectedRequestIdSet = new Set(uniqueStrings(normalizedSelection?.requestIds || []).filter((requestId) => allRequests.some((request) => request.id === requestId)));

    const exportedFolderPathSet = new Set();
    const exportedRequestIdSet = new Set();

    if (!hasSelection) {
        allFolders.forEach((folderPath) => exportedFolderPathSet.add(folderPath));
        allRequests.forEach((request) => exportedRequestIdSet.add(request.id));
    } else {
        selectedFolderPathSet.forEach((folderPath) => exportedFolderPathSet.add(folderPath));
        selectedRequestIdSet.forEach((requestId) => exportedRequestIdSet.add(requestId));
    }

    for (const request of allRequests) {
        if (!exportedRequestIdSet.has(request.id)) {
            continue;
        }

        for (const folderPath of getFolderAncestors(request.path || '')) {
            exportedFolderPathSet.add(folderPath);
        }
    }

    for (const folderPath of [...exportedFolderPathSet]) {
        for (const ancestorPath of getFolderAncestors(folderPath)) {
            exportedFolderPathSet.add(ancestorPath);
        }
    }

    const exportedFolders = orderFolderPaths(
        allFolders.filter((folderPath) => exportedFolderPathSet.has(folderPath)),
        Array.isArray(snapshot?.folders) ? snapshot.folders : [],
    );
    const exportedRequests = allRequests
        .filter((request) => exportedRequestIdSet.has(request.id))
        .map((request) => ({
            ...serializeRequest(request),
            path: request.path || '',
        }));

    return {
        type: 'workspace-export',
        version: 2,
        exported_at: new Date().toISOString(),
        workspace_id: snapshot.workspaceId,
        workspace_name: snapshot.workspaceName,
        folders: exportedFolders,
        folder_order: exportedFolders,
        folder_records: synchronizeFolderRecords(exportedFolders, folderRecords),
        requests: exportedRequests,
        environments: includeEnvironments ? snapshot.environments : undefined,
    };
}

function remapFolderOrder(folderPaths, sourcePath, destinationPath) {
    const cleanSourcePath = cleanRelativePath(sourcePath);
    const cleanDestinationPath = cleanRelativePath(destinationPath);

    return folderPaths.map((folderPath) => {
        const cleanPath = cleanRelativePath(folderPath);
        if (cleanPath === cleanSourcePath) {
            return cleanDestinationPath;
        }

        if (cleanPath.startsWith(`${cleanSourcePath}/`)) {
            return cleanRelativePath(`${cleanDestinationPath}${cleanPath.slice(cleanSourcePath.length)}`);
        }

        return cleanPath;
    });
}

function buildFolderTree(folderPaths) {
    const root = { path: '', name: '', children: [] };
    const nodeMap = new Map([['', root]]);

    for (const folderPath of folderPaths) {
        const cleanPath = cleanRelativePath(folderPath);
        const parentPath = folderParentPath(cleanPath);
        const node = {
            path: cleanPath,
            name: folderNameFromPath(cleanPath),
            children: [],
        };
        nodeMap.set(cleanPath, node);
        nodeMap.get(parentPath)?.children.push(node);
    }

    return { root, nodeMap };
}

function renameFolderSubtree(node, parentPath) {
    node.path = cleanRelativePath(path.posix.join(parentPath, node.name));
    for (const child of node.children) {
        renameFolderSubtree(child, node.path);
    }
}

function flattenFolderTree(root) {
    const ordered = [];

    function visit(node) {
        for (const child of node.children) {
            ordered.push(child.path);
            visit(child);
        }
    }

    visit(root);
    return ordered;
}

function reorderFolderPaths(folderPaths, movedFolderPath, targetParentPath = '', insertIndex) {
    const sourcePath = cleanRelativePath(movedFolderPath);
    const destinationParentPath = cleanRelativePath(targetParentPath);

    if (!sourcePath) {
        throw new Error('Cannot move the workspace root.');
    }

    if (destinationParentPath === sourcePath || destinationParentPath.startsWith(`${sourcePath}/`)) {
        throw new Error('Cannot move a folder into itself or one of its descendants.');
    }

    const { root, nodeMap } = buildFolderTree(folderPaths);
    const sourceNode = nodeMap.get(sourcePath);
    const sourceParent = nodeMap.get(folderParentPath(sourcePath)) || root;
    const destinationParent = destinationParentPath ? nodeMap.get(destinationParentPath) : root;

    if (!sourceNode) {
        throw new Error('Folder could not be found.');
    }

    if (!destinationParent) {
        throw new Error('Destination folder could not be found.');
    }

    const sourceIndex = sourceParent.children.findIndex((child) => child === sourceNode);
    if (sourceIndex === -1) {
        throw new Error('Folder parent relationship is invalid.');
    }

    sourceParent.children.splice(sourceIndex, 1);

    const destinationChildren = destinationParent.children;
    let nextInsertIndex = typeof insertIndex === 'number' ? insertIndex : destinationChildren.length;

    if (sourceParent === destinationParent && sourceIndex < nextInsertIndex) {
        nextInsertIndex -= 1;
    }

    nextInsertIndex = Math.max(0, Math.min(nextInsertIndex, destinationChildren.length));

    destinationChildren.splice(nextInsertIndex, 0, sourceNode);

    const nextSourcePath = cleanRelativePath(path.posix.join(destinationParentPath, sourceNode.name));
    if (nextSourcePath !== sourcePath) {
        renameFolderSubtree(sourceNode, destinationParentPath);
    }

    return flattenFolderTree(root);
}

async function fileExists(filePath) {
    try {
        await fs.access(filePath);
        return true;
    } catch {
        return false;
    }
}

async function ensureUniqueRelativePath(workspacePath, desiredRelativePath, currentRelativePath = '') {
    const cleanDesired = cleanRelativePath(desiredRelativePath);
    const cleanCurrent = cleanRelativePath(currentRelativePath);

    if (!cleanDesired) {
        return buildRequestFileName('Untitled Request');
    }

    if (cleanDesired === cleanCurrent) {
        return cleanDesired;
    }

    const parsed = path.posix.parse(cleanDesired);
    let attempt = cleanDesired;
    let counter = 1;

    while (await fileExists(path.join(workspacePath, attempt))) {
        attempt = cleanRelativePath(path.posix.join(parsed.dir, `${parsed.name} ${counter}${parsed.ext}`));
        if (attempt === cleanCurrent) {
            return attempt;
        }
        counter += 1;
    }

    return attempt;
}

async function readJson(filePath) {
    const content = await fs.readFile(filePath, 'utf8');
    return JSON.parse(content);
}

async function readText(filePath) {
    return fs.readFile(filePath, 'utf8');
}

async function writeJson(filePath, value) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function removeIfExists(filePath) {
    try {
        await fs.unlink(filePath);
    } catch (error) {
        if (error.code !== 'ENOENT') {
            throw error;
        }
    }
}

async function walkWorkspace(workspacePath, relativePath = '', accumulator = { folders: [], requests: [] }) {
    const absolutePath = path.join(workspacePath, relativePath);
    const entries = await fs.readdir(absolutePath, { withFileTypes: true });

    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        const childRelativePath = cleanRelativePath(path.posix.join(cleanRelativePath(relativePath), entry.name));
        const childAbsolutePath = path.join(workspacePath, childRelativePath);

        if (entry.isDirectory()) {
            accumulator.folders.push(childRelativePath);
            await walkWorkspace(workspacePath, childRelativePath, accumulator);
            continue;
        }

        if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.json' || entry.name === ENVIRONMENTS_FILE || entry.name === WORKSPACE_METADATA_FILE) {
            continue;
        }

        try {
            const parsed = await readJson(childAbsolutePath);
            accumulator.requests.push(normalizeRequestPayload(parsed, childRelativePath));
        } catch {
            continue;
        }
    }

    return accumulator;
}

async function loadWorkspaceMetadata(workspacePath) {
    const metadataPath = path.join(workspacePath, WORKSPACE_METADATA_FILE);

    try {
        const parsed = await readJson(metadataPath);
        return {
            workspace_id: typeof parsed?.workspace_id === 'string' ? parsed.workspace_id : '',
            workspace_name: typeof parsed?.workspace_name === 'string' && parsed.workspace_name.trim() ? parsed.workspace_name.trim() : folderNameFromPath(workspacePath) || DEFAULT_WORKSPACE_NAME,
            folder_order: Array.isArray(parsed?.folder_order) ? parsed.folder_order.map((folderPath) => cleanRelativePath(folderPath)).filter(Boolean) : [],
            folders: normalizeFolderRecords(parsed?.folders),
        };
    } catch {
        return defaultWorkspaceMetadata();
    }
}

function getManagedWorkspacesRootPath() {
    return path.join(app.getPath('userData'), MANAGED_WORKSPACES_DIRECTORY);
}

function getWorkspaceStatePath() {
    return path.join(app.getPath('userData'), WORKSPACE_STATE_FILE);
}

function slugifyWorkspaceName(name) {
    return safeFileName(name || 'Workspace')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'workspace';
}

async function loadWorkspaceState() {
    try {
        const parsed = await readJson(getWorkspaceStatePath());
        return {
            active_workspace_id: typeof parsed?.active_workspace_id === 'string' ? parsed.active_workspace_id : '',
            workspace_ui_state_by_id: normalizeWorkspaceUiStateById(parsed?.workspace_ui_state_by_id),
        };
    } catch {
        return defaultWorkspaceState();
    }
}

async function saveWorkspaceState(state) {
    await writeJson(getWorkspaceStatePath(), {
        active_workspace_id: typeof state?.active_workspace_id === 'string' ? state.active_workspace_id : '',
        workspace_ui_state_by_id: normalizeWorkspaceUiStateById(state?.workspace_ui_state_by_id),
    });
}

async function ensureUniqueWorkspaceDirectoryPath(workspaceName) {
    const workspacesRootPath = getManagedWorkspacesRootPath();
    const baseSlug = slugifyWorkspaceName(workspaceName);
    let attempt = baseSlug;
    let counter = 1;

    while (await fileExists(path.join(workspacesRootPath, attempt))) {
        attempt = `${baseSlug}-${counter}`;
        counter += 1;
    }

    return path.join(workspacesRootPath, attempt);
}

async function listManagedWorkspaces() {
    const workspacesRootPath = getManagedWorkspacesRootPath();
    await fs.mkdir(workspacesRootPath, { recursive: true });

    const entries = await fs.readdir(workspacesRootPath, { withFileTypes: true });
    const workspaces = [];

    for (const entry of entries) {
        if (!entry.isDirectory()) {
            continue;
        }

        const workspacePath = path.join(workspacesRootPath, entry.name);
        const metadata = await loadWorkspaceMetadata(workspacePath);
        const workspaceId = metadata.workspace_id || randomUUID();
        const workspaceName = metadata.workspace_name || entry.name;
        const nextMetadata = {
            ...metadata,
            workspace_id: workspaceId,
            workspace_name: workspaceName,
        };

        if (nextMetadata.workspace_id !== metadata.workspace_id || nextMetadata.workspace_name !== metadata.workspace_name) {
            await writeJson(path.join(workspacePath, WORKSPACE_METADATA_FILE), nextMetadata);
        }

        workspaces.push({
            id: workspaceId,
            name: workspaceName,
            path: workspacePath,
        });
    }

    return workspaces.sort((left, right) => left.name.localeCompare(right.name));
}

async function ensureManagedDefaultWorkspace() {
    const workspacesRootPath = getManagedWorkspacesRootPath();
    await fs.mkdir(workspacesRootPath, { recursive: true });
    const existingWorkspaces = await listManagedWorkspaces();
    if (existingWorkspaces.length > 0) {
        return existingWorkspaces;
    }

    const defaultWorkspacePath = path.join(workspacesRootPath, 'default');
    await ensureWorkspaceReady(defaultWorkspacePath, {
        workspaceName: DEFAULT_WORKSPACE_NAME,
        workspaceId: 'workspace-default',
    });

    return listManagedWorkspaces();
}

async function findManagedWorkspaceById(workspaceId) {
    const workspaces = await ensureManagedDefaultWorkspace();
    return workspaces.find((workspace) => workspace.id === workspaceId) || null;
}

async function buildManagedWorkspaceSnapshot(workspacePath) {
    const snapshot = await loadWorkspaceSnapshot(workspacePath);
    const workspaces = await ensureManagedDefaultWorkspace();
    const activeWorkspace = workspaces.find((workspace) => workspace.path === workspacePath) || null;
    const workspaceState = await loadWorkspaceState();
    const validWorkspaceIds = new Set(workspaces.map((workspace) => workspace.id));
    const nextWorkspaceState = {
        active_workspace_id: activeWorkspace?.id || '',
        workspace_ui_state_by_id: Object.fromEntries(
            Object.entries(workspaceState.workspace_ui_state_by_id || {}).filter(([workspaceId]) => validWorkspaceIds.has(workspaceId)),
        ),
    };

    await saveWorkspaceState(nextWorkspaceState);

    return {
        ...snapshot,
        workspace: activeWorkspace,
        workspaces,
        workspacesRootPath: getManagedWorkspacesRootPath(),
        uiState: activeWorkspace ? nextWorkspaceState.workspace_ui_state_by_id[activeWorkspace.id] || defaultWorkspaceUiState() : defaultWorkspaceUiState(),
    };
}

async function bootstrapManagedWorkspace() {
    const workspaces = await ensureManagedDefaultWorkspace();
    const workspaceState = await loadWorkspaceState();
    const activeWorkspace = workspaces.find((workspace) => workspace.id === workspaceState.active_workspace_id) || workspaces[0];
    return buildManagedWorkspaceSnapshot(activeWorkspace.path);
}

async function importPayloadIntoWorkspace(workspacePath, payload) {
    const currentSnapshot = await loadWorkspaceSnapshot(workspacePath);
    const idMap = buildIdMap(currentSnapshot.requests);

    if (Array.isArray(payload.requests)) {
        const importedFolderRecords = normalizeImportedFolderRecords(payload);
        if (Array.isArray(payload.folders)) {
            for (const folderPath of payload.folders) {
                const targetFolderPath = cleanRelativePath(folderPath);
                if (!targetFolderPath) {
                    continue;
                }
                await fs.mkdir(path.join(workspacePath, targetFolderPath), { recursive: true });
            }
        }

        for (const item of payload.requests) {
            const normalized = normalizeRequestPayload(item, '');
            const targetRelativePath = cleanRelativePath(path.posix.join(item.path || '', buildRequestFileName(normalized.name)));
            const existingRelativePath = idMap.get(normalized.id);

            if (existingRelativePath && existingRelativePath !== targetRelativePath) {
                await removeIfExists(path.join(workspacePath, existingRelativePath));
            }

            await writeJson(path.join(workspacePath, targetRelativePath), serializeRequest(normalized));
            idMap.set(normalized.id, targetRelativePath);
        }

        if (payload.environments) {
            await writeJson(path.join(workspacePath, ENVIRONMENTS_FILE), normalizeEnvironmentsState(payload.environments));
        }

        const metadata = await loadWorkspaceMetadata(workspacePath);
        await writeJson(path.join(workspacePath, WORKSPACE_METADATA_FILE), {
            ...metadata,
            workspace_id: typeof payload?.workspace_id === 'string' && payload.workspace_id.trim() ? payload.workspace_id.trim() : metadata.workspace_id,
            workspace_name: typeof payload?.workspace_name === 'string' && payload.workspace_name.trim() ? payload.workspace_name.trim() : metadata.workspace_name,
            folder_order: orderFolderPaths(payload.folders || [], Array.isArray(payload.folder_order) ? payload.folder_order : payload.folders || []),
            folders: synchronizeFolderRecords(payload.folders || [], importedFolderRecords),
        });

        return loadWorkspaceSnapshot(workspacePath);
    }

    const normalized = normalizeRequestPayload(payload, '');
    const targetRelativePath = cleanRelativePath(buildRequestFileName(normalized.name));
    const existingRelativePath = idMap.get(normalized.id);

    if (existingRelativePath && existingRelativePath !== targetRelativePath) {
        await removeIfExists(path.join(workspacePath, existingRelativePath));
    }

    await writeJson(path.join(workspacePath, targetRelativePath), serializeRequest(normalized));
    return loadWorkspaceSnapshot(workspacePath);
}

async function replaceWorkspaceStructure(workspacePath, payload) {
    const currentSnapshot = await loadWorkspaceSnapshot(workspacePath);
    const metadata = await loadWorkspaceMetadata(workspacePath);
    const targetFolders = orderFolderPaths(
        Array.isArray(payload?.folders) ? payload.folders : [],
        Array.isArray(payload?.folder_order) ? payload.folder_order : payload?.folders || [],
    );
    const targetFolderRecords = synchronizeFolderRecords(targetFolders, metadata.folders || []);
    const targetRequests = (Array.isArray(payload?.requests) ? payload.requests : []).map((request) => normalizeRequestPayload(request, request?.filePath || ''));

    for (const request of currentSnapshot.requests || []) {
        const currentRelativePath = cleanRelativePath(request.filePath || path.posix.join(request.path || '', buildRequestFileName(request.name)));
        if (!currentRelativePath) {
            continue;
        }

        await removeIfExists(path.join(workspacePath, currentRelativePath));
    }

    for (const folderPath of [...(currentSnapshot.folders || [])].sort((left, right) => right.length - left.length)) {
        if (targetFolders.includes(folderPath)) {
            continue;
        }

        await fs.rm(path.join(workspacePath, folderPath), { recursive: true, force: true });
    }

    for (const folderPath of targetFolders) {
        await fs.mkdir(path.join(workspacePath, folderPath), { recursive: true });
    }

    for (const request of targetRequests) {
        const targetRelativePath = cleanRelativePath(request.filePath || path.posix.join(request.path || '', buildRequestFileName(request.name)));
        if (!targetRelativePath) {
            continue;
        }

        await writeJson(path.join(workspacePath, targetRelativePath), serializeRequest(request));
    }

    await writeJson(path.join(workspacePath, WORKSPACE_METADATA_FILE), {
        ...metadata,
        folder_order: targetFolders,
        folders: targetFolderRecords,
    });

    return buildManagedWorkspaceSnapshot(workspacePath);
}

async function loadEnvironments(workspacePath) {
    const environmentsPath = path.join(workspacePath, ENVIRONMENTS_FILE);

    try {
        return normalizeEnvironmentsState(await readJson(environmentsPath));
    } catch {
        return defaultEnvironments();
    }
}

async function loadWorkspaceSnapshot(workspacePath) {
    const workspace = await walkWorkspace(workspacePath);
    const environments = await loadEnvironments(workspacePath);
    const metadata = await loadWorkspaceMetadata(workspacePath);
    const orderedFolders = orderFolderPaths(workspace.folders, metadata.folder_order || []);
    const nextFolderRecords = synchronizeFolderRecords(orderedFolders, metadata.folders || []);

    if (!folderOrderEquals(orderedFolders, metadata.folder_order || []) || !folderRecordsEqual(nextFolderRecords, normalizeFolderRecords(metadata.folders || []))) {
        await writeJson(path.join(workspacePath, WORKSPACE_METADATA_FILE), {
            ...metadata,
            folder_order: orderedFolders,
            folders: nextFolderRecords,
        });
    }

    return {
        workspacePath,
        workspaceName: metadata.workspace_name || folderNameFromPath(workspacePath) || DEFAULT_WORKSPACE_NAME,
        workspaceId: metadata.workspace_id || '',
        folders: orderedFolders,
        requests: workspace.requests,
        environments,
    };
}

async function ensureWorkspaceReady(workspacePath, options: { workspaceId?: string; workspaceName?: string } = {}) {
    await fs.mkdir(workspacePath, { recursive: true });

    const environmentsPath = path.join(workspacePath, ENVIRONMENTS_FILE);
    if (!(await fileExists(environmentsPath))) {
        await writeJson(environmentsPath, defaultEnvironments());
    }

    const metadata = await loadWorkspaceMetadata(workspacePath);
    const nextMetadata = {
        workspace_id: options.workspaceId || metadata.workspace_id || randomUUID(),
        workspace_name: options.workspaceName || metadata.workspace_name || folderNameFromPath(workspacePath) || DEFAULT_WORKSPACE_NAME,
        folder_order: metadata.folder_order || [],
        folders: synchronizeFolderRecords([], metadata.folders || []),
    };
    await writeJson(path.join(workspacePath, WORKSPACE_METADATA_FILE), nextMetadata);

    return loadWorkspaceSnapshot(workspacePath);
}

async function mergeImportedWorkspaceById(workspacePath, payload) {
    const currentSnapshot = await loadWorkspaceSnapshot(workspacePath);
    const currentMetadata = await loadWorkspaceMetadata(workspacePath);
    let nextFolderOrder = currentMetadata.folder_order || currentSnapshot.folders || [];
    let nextFolderRecords = synchronizeFolderRecords(currentSnapshot.folders || [], currentMetadata.folders || []);
    const importedFolderRecords = normalizeImportedFolderRecords(payload);
    const importedFolderOrder = mergePreferredFolderOrder(
        Array.isArray(payload?.folder_order) ? payload.folder_order : importedFolderRecords.map((record) => record.path),
        importedFolderRecords.map((record) => record.path),
    );

    const sortedImportedFolderRecords = [...importedFolderRecords].sort((left, right) => {
        const depthDifference = left.path.split('/').length - right.path.split('/').length;
        if (depthDifference !== 0) {
            return depthDifference;
        }

        return left.path.localeCompare(right.path);
    });

    for (const importedRecord of sortedImportedFolderRecords) {
        const desiredPath = cleanRelativePath(importedRecord.path);
        if (!desiredPath) {
            continue;
        }

        const currentFolderPathById = new Map(nextFolderRecords.map((record) => [record.id, record.path]));
        const existingPath = currentFolderPathById.get(importedRecord.id) || '';
        const desiredAbsolutePath = path.join(workspacePath, desiredPath);

        if (existingPath) {
            if (existingPath === desiredPath) {
                continue;
            }

            const sourceAbsolutePath = path.join(workspacePath, existingPath);
            await fs.mkdir(path.dirname(desiredAbsolutePath), { recursive: true });

            if (await fileExists(sourceAbsolutePath)) {
                if (!(await fileExists(desiredAbsolutePath))) {
                    await fs.rename(sourceAbsolutePath, desiredAbsolutePath);
                }
            } else if (!(await fileExists(desiredAbsolutePath))) {
                await fs.mkdir(desiredAbsolutePath, { recursive: true });
            }

            nextFolderOrder = remapFolderOrder(nextFolderOrder, existingPath, desiredPath);
            nextFolderRecords = remapFolderRecords(nextFolderRecords, existingPath, desiredPath);
            continue;
        }

        if (!(await fileExists(desiredAbsolutePath))) {
            await fs.mkdir(desiredAbsolutePath, { recursive: true });
        }

        nextFolderRecords = normalizeFolderRecords([...nextFolderRecords, { id: importedRecord.id, path: desiredPath }]);
    }

    const idMap = buildIdMap(currentSnapshot.requests);

    for (const item of Array.isArray(payload?.requests) ? payload.requests : []) {
        const normalized = normalizeRequestPayload(item, '');
        const desiredRelativePath = buildImportedRequestRelativePath(item);
        const existingRelativePath = idMap.get(normalized.id) || '';
        const finalRelativePath = await ensureUniqueRelativePath(workspacePath, desiredRelativePath, existingRelativePath);

        await fs.mkdir(path.dirname(path.join(workspacePath, finalRelativePath)), { recursive: true });
        await writeJson(path.join(workspacePath, finalRelativePath), serializeRequest(normalized));

        if (existingRelativePath && existingRelativePath !== finalRelativePath) {
            await removeIfExists(path.join(workspacePath, existingRelativePath));
        }

        idMap.set(normalized.id, finalRelativePath);
    }

    if (payload?.environments) {
        await writeJson(path.join(workspacePath, ENVIRONMENTS_FILE), normalizeEnvironmentsState(payload.environments));
    }

    const nextSnapshot = await loadWorkspaceSnapshot(workspacePath);
    await writeJson(path.join(workspacePath, WORKSPACE_METADATA_FILE), {
        workspace_id: typeof payload?.workspace_id === 'string' && payload.workspace_id.trim() ? payload.workspace_id.trim() : currentMetadata.workspace_id || nextSnapshot.workspaceId || randomUUID(),
        workspace_name: typeof payload?.workspace_name === 'string' && payload.workspace_name.trim() ? payload.workspace_name.trim() : currentMetadata.workspace_name || nextSnapshot.workspaceName || DEFAULT_WORKSPACE_NAME,
        folder_order: orderFolderPaths(nextSnapshot.folders || [], mergePreferredFolderOrder(importedFolderOrder, nextFolderOrder)),
        folders: synchronizeFolderRecords(nextSnapshot.folders || [], normalizeFolderRecords([...nextFolderRecords, ...importedFolderRecords])),
    });

    return loadWorkspaceSnapshot(workspacePath);
}

function buildIdMap(requests) {
    const map = new Map();
    for (const request of requests) {
        map.set(request.id, request.filePath);
    }
    return map;
}

function sortInsomniaItems(items) {
    return (Array.isArray(items) ? items : [])
        .map((item, index) => ({ item, index }))
        .sort((left, right) => {
            const leftSortKey = Number.isFinite(left.item?.meta?.sortKey) ? Number(left.item.meta.sortKey) : Number.POSITIVE_INFINITY;
            const rightSortKey = Number.isFinite(right.item?.meta?.sortKey) ? Number(right.item.meta.sortKey) : Number.POSITIVE_INFINITY;
            if (leftSortKey !== rightSortKey) {
                return leftSortKey - rightSortKey;
            }

            return left.index - right.index;
        })
        .map(({ item }) => item);
}

function rewriteInsomniaTemplateString(value, mapReference) {
    return String(value || '').replace(/{{\s*_\.\s*([^{}]+?)\s*}}/g, (_, key) => `{{${mapReference(String(key || '').trim())}}}`);
}

function normalizeInsomniaTemplateString(value) {
    return rewriteInsomniaTemplateString(value, (key) => `${BASE_ENVIRONMENT_PREFIX}.${key}`);
}

function preserveInsomniaRuntimeTemplateString(value) {
    return rewriteInsomniaTemplateString(value, (key) => `${INSOMNIA_RUNTIME_ENV_PREFIX}.${key}`);
}

function normalizeInsomniaTemplateValue(value) {
    if (typeof value === 'string') {
        return normalizeInsomniaTemplateString(value);
    }

    if (Array.isArray(value)) {
        return value.map((item) => normalizeInsomniaTemplateValue(item));
    }

    if (isPlainObject(value)) {
        return Object.fromEntries(Object.entries(value).map(([key, entryValue]) => [key, normalizeInsomniaTemplateValue(entryValue)]));
    }

    return value;
}

function unwrapInsomniaEnvironmentRoot(value) {
    let currentValue = value;

    while (isPlainObject(currentValue)) {
        const keys = Object.keys(currentValue);
        if (keys.length !== 1 || keys[0] !== '' || !isPlainObject(currentValue[''])) {
            break;
        }

        currentValue = currentValue[''];
    }

    return currentValue;
}

function stringifyImportedValue(value) {
    if (typeof value === 'string') {
        return preserveInsomniaRuntimeTemplateString(value);
    }

    if (value === undefined || value === null) {
        return '';
    }

    return JSON.stringify(normalizeInsomniaTemplateValue(value));
}

function parseInsomniaRows(values) {
    if (Array.isArray(values)) {
        return values
            .map((value) => ({
                key: preserveInsomniaRuntimeTemplateString(value?.name || value?.key || ''),
                value: stringifyImportedValue(value?.value || ''),
                enabled: value?.disabled !== true && value?.enabled !== false,
            }))
            .filter((row) => row.key || row.value);
    }

    if (isPlainObject(values)) {
        return Object.entries(values).map(([key, value]) => ({
            key: preserveInsomniaRuntimeTemplateString(key),
            value: stringifyImportedValue(value),
            enabled: true,
        }));
    }

    return [];
}

function parseInsomniaBody(body) {
    const mimeType = String(body?.mimeType || '').toLowerCase();

    if (typeof body?.text === 'string' && body.text.length > 0) {
        return {
            type: mimeType.includes('json') ? 'json' : 'raw',
            content: preserveInsomniaRuntimeTemplateString(body.text),
        };
    }

    if (Array.isArray(body?.params) && body.params.length > 0) {
        const content = body.params
            .filter((param) => param?.disabled !== true)
            .map((param) => `${encodeURIComponent(String(param?.name || ''))}=${encodeURIComponent(String(param?.value || ''))}`)
            .join('&');

        return {
            type: 'raw',
            content,
        };
    }

    return {
        type: 'none',
        content: '',
    };
}

function parseInsomniaAuth(authentication) {
    const authType = String(authentication?.type || '').toLowerCase();

    if (authType === 'basic') {
        return normalizeAuthShape({
            type: 'basic',
            username: preserveInsomniaRuntimeTemplateString(authentication?.username || ''),
            password: preserveInsomniaRuntimeTemplateString(authentication?.password || ''),
        });
    }

    if (authType === 'bearer') {
        return normalizeAuthShape({
            type: 'bearer',
            bearerToken: preserveInsomniaRuntimeTemplateString(authentication?.token || authentication?.value || authentication?.accessToken || ''),
        });
    }

    if (authType === 'oauth2') {
        const addTokenTo = String(authentication?.addTokenTo || authentication?.tokenPlacement || '').toLowerCase() === 'query' ? 'query' : 'request_header';
        return normalizeAuthShape({
            type: 'oauth2',
            oauth2: {
                ...defaultOAuth2(),
                grantType: String(authentication?.grantType || 'client_credentials'),
                accessTokenUrl: preserveInsomniaRuntimeTemplateString(authentication?.accessTokenUrl || authentication?.tokenUrl || ''),
                authorizationUrl: preserveInsomniaRuntimeTemplateString(authentication?.authorizationUrl || ''),
                authorizationCode: preserveInsomniaRuntimeTemplateString(authentication?.authorizationCode || authentication?.code || ''),
                redirectUri: preserveInsomniaRuntimeTemplateString(authentication?.redirectUri || ''),
                clientId: preserveInsomniaRuntimeTemplateString(authentication?.clientId || ''),
                clientSecret: preserveInsomniaRuntimeTemplateString(authentication?.clientSecret || ''),
                scope: preserveInsomniaRuntimeTemplateString(authentication?.scope || ''),
                audience: preserveInsomniaRuntimeTemplateString(authentication?.audience || ''),
                resource: preserveInsomniaRuntimeTemplateString(authentication?.resource || ''),
                username: preserveInsomniaRuntimeTemplateString(authentication?.username || ''),
                password: preserveInsomniaRuntimeTemplateString(authentication?.password || ''),
                accessToken: preserveInsomniaRuntimeTemplateString(authentication?.accessToken || authentication?.token || ''),
                tokenPrefix: preserveInsomniaRuntimeTemplateString(authentication?.tokenPrefix || 'Bearer'),
                addTokenTo,
                tokenParameterName: preserveInsomniaRuntimeTemplateString(authentication?.tokenParameterName || (addTokenTo === 'query' ? 'access_token' : 'Authorization')),
                clientAuthentication: String(authentication?.clientAuthentication || '').toLowerCase() === 'body' ? 'body' : 'basic',
                state: preserveInsomniaRuntimeTemplateString(authentication?.state || ''),
                codeVerifier: preserveInsomniaRuntimeTemplateString(authentication?.codeVerifier || ''),
            },
        });
    }

    return normalizeAuthShape({ type: 'none' });
}

function parseInsomniaExport(content, sourceFilePath = '') {
    let payload;

    try {
        payload = yaml.parse(content);
    } catch (error) {
        throw new Error(`Failed to parse the Insomnia export file. ${error.message || ''}`.trim());
    }

    if (!isPlainObject(payload)) {
        throw new Error('Unsupported Insomnia export. Expected a collection export document.');
    }

    const exportType = String(payload.type || '').trim();
    if (!exportType.startsWith('collection.insomnia.rest/')) {
        throw new Error('Unsupported Insomnia export. Expected the newer Insomnia collection export format.');
    }

    const folderPaths = [];
    const usedFolderPaths = new Set();
    const requests = [];
    const nextOrderByFolderPath = new Map();

    function nextRequestOrder(folderPath) {
        const normalizedFolderPath = cleanRelativePath(folderPath);
        const nextOrder = (nextOrderByFolderPath.get(normalizedFolderPath) || 0) + 1;
        nextOrderByFolderPath.set(normalizedFolderPath, nextOrder);
        return nextOrder;
    }

    function createUniqueFolderPath(parentPath, folderName) {
        const safeName = sanitizeSegment(folderName || 'Folder');
        let attempt = cleanRelativePath(path.posix.join(parentPath, safeName));
        let counter = 1;

        while (usedFolderPaths.has(attempt)) {
            attempt = cleanRelativePath(path.posix.join(parentPath, `${safeName} ${counter}`));
            counter += 1;
        }

        usedFolderPaths.add(attempt);
        folderPaths.push(attempt);
        return attempt;
    }

    function walkCollection(items, parentPath = '') {
        for (const item of sortInsomniaItems(items)) {
            if (!item || typeof item !== 'object') {
                continue;
            }

            if (Array.isArray(item.children)) {
                const folderPath = createUniqueFolderPath(parentPath, item.name || 'Folder');
                walkCollection(item.children, folderPath);
                continue;
            }

            const requestId = typeof item?.meta?.id === 'string' && item.meta.id.trim() ? item.meta.id.trim() : randomUUID();
            requests.push({
                id: requestId,
                name: String(item.name || 'Untitled Request').trim() || 'Untitled Request',
                order: nextRequestOrder(parentPath),
                method: String(item.method || 'GET').toUpperCase(),
                url: preserveInsomniaRuntimeTemplateString(item.url || ''),
                headers: parseInsomniaRows(item.headers),
                query_params: parseInsomniaRows(item.parameters || item.params),
                body: parseInsomniaBody(item.body),
                auth: parseInsomniaAuth(item.authentication),
                path: cleanRelativePath(parentPath),
            });
        }
    }

    walkCollection(payload.collection || [], '');

    let baseEnvironment = null;
    const parsedEnvironments = [];

    function environmentChildren(node) {
        if (Array.isArray(node?.subEnvironments)) {
            return node.subEnvironments;
        }

        if (Array.isArray(node?.children)) {
            return node.children;
        }

        return [];
    }

    function buildEnvironmentDisplayName(lineage, nodeName) {
        const combined = [...lineage, nodeName].filter(Boolean);
        if (combined.length === 0) {
            return 'Environment';
        }

        if (combined[0] === 'Base Environment' && combined.length > 1) {
            return combined.slice(1).join(' / ');
        }

        return combined.join(' / ');
    }

    function walkEnvironments(node, lineage = []) {
        if (!node || typeof node !== 'object') {
            return;
        }

        const nodeName = String(node.name || 'Environment').trim() || 'Environment';
        const nodeVariables = isPlainObject(node.data) ? normalizeInsomniaTemplateValue(node.data) : {};
        const environmentId = typeof node?.meta?.id === 'string' && node.meta.id.trim() ? node.meta.id.trim() : randomUUID();

        if (lineage.length === 0 && !baseEnvironment) {
            baseEnvironment = {
                id: BASE_ENVIRONMENT_ID,
                name: BASE_ENVIRONMENT_NAME,
                variables: unwrapInsomniaEnvironmentRoot(nodeVariables),
            };

            for (const child of sortInsomniaItems(environmentChildren(node))) {
                walkEnvironments(child, []);
            }

            return;
        }

        parsedEnvironments.push({
            id: environmentId,
            name: buildEnvironmentDisplayName(lineage, nodeName),
            variables: nodeVariables,
        });

        for (const child of sortInsomniaItems(environmentChildren(node))) {
            walkEnvironments(child, [...lineage, nodeName]);
        }
    }

    if (Array.isArray(payload.environments)) {
        for (const environment of sortInsomniaItems(payload.environments)) {
            walkEnvironments(environment, []);
        }
    } else if (payload.environments) {
        walkEnvironments(payload.environments, []);
    }

    const activeEnvironmentId = parsedEnvironments[0]?.id || 'env_default';
    const normalizedEnvironmentState = normalizeEnvironmentsState({
        active_environment_id: activeEnvironmentId,
        base_environment: baseEnvironment || defaultEnvironments().base_environment,
        environments: parsedEnvironments,
    });

    return {
        type: 'workspace-export',
        version: 2,
        workspace_id: typeof payload?.meta?.id === 'string' && payload.meta.id.trim() ? payload.meta.id.trim() : '',
        workspace_name: String(payload.name || path.parse(sourceFilePath).name || 'Imported Insomnia Workspace').trim() || 'Imported Insomnia Workspace',
        folders: orderFolderPaths(folderPaths, folderPaths),
        folder_order: folderPaths,
        requests: finalizeInsomniaImportedRequests(requests, normalizedEnvironmentState),
        environments: normalizedEnvironmentState,
    };
}

function finalizeInsomniaRuntimeTemplateString(value, environmentsState) {
    return String(value || '').replace(new RegExp(`{{\\s*${INSOMNIA_RUNTIME_ENV_PREFIX.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\.([^{}]+?)\\s*}}`, 'g'), (_, key) => {
        const trimmedKey = String(key || '').trim();
        return `{{${mapInsomniaRuntimeReference(trimmedKey, environmentsState)}}}`;
    });
}

function finalizeInsomniaImportedValue(value, environmentsState) {
    if (typeof value === 'string') {
        return finalizeInsomniaRuntimeTemplateString(value, environmentsState);
    }

    if (Array.isArray(value)) {
        return value.map((item) => finalizeInsomniaImportedValue(item, environmentsState));
    }

    if (isPlainObject(value)) {
        return Object.fromEntries(Object.entries(value).map(([key, entryValue]) => [
            finalizeInsomniaRuntimeTemplateString(key, environmentsState),
            finalizeInsomniaImportedValue(entryValue, environmentsState),
        ]));
    }

    return value;
}

function mapInsomniaRuntimeReference(variableName, environmentsState) {
    const normalizedState = normalizeEnvironmentsState(environmentsState);
    const existsInRuntimeEnvironment = normalizedState.environments.some((environment) => resolveEnvironmentValue(environment.variables, variableName) !== undefined);
    if (existsInRuntimeEnvironment) {
        return variableName;
    }

    if (resolveEnvironmentValue(normalizedState.base_environment?.variables, variableName) !== undefined) {
        return `${BASE_ENVIRONMENT_PREFIX}.${variableName}`;
    }

    return variableName;
}

function finalizeInsomniaImportedRequests(requests, environmentsState) {
    return (Array.isArray(requests) ? requests : []).map((request) => ({
        ...request,
        url: finalizeInsomniaRuntimeTemplateString(request.url || '', environmentsState),
        headers: finalizeInsomniaImportedValue(request.headers || [], environmentsState),
        query_params: finalizeInsomniaImportedValue(request.query_params || [], environmentsState),
        body: finalizeInsomniaImportedValue(request.body || { type: 'none', content: '' }, environmentsState),
        auth: finalizeInsomniaImportedValue(request.auth || normalizeAuthShape({ type: 'none' }), environmentsState),
    }));
}

function isPlainObject(value) {
    return Boolean(value) && Object.prototype.toString.call(value) === '[object Object]';
}

function normalizeEnvironmentPath(input) {
    return String(input || '')
        .split('.')
        .map((segment) => segment.trim())
        .filter(Boolean);
}

function resolveEnvironmentValue(variables, variableName) {
    const pathSegments = normalizeEnvironmentPath(variableName);
    if (pathSegments.length === 0) {
        return undefined;
    }

    let currentValue = variables;
    for (const segment of pathSegments) {
        if (Array.isArray(currentValue)) {
            const index = Number.parseInt(segment, 10);
            if (!Number.isInteger(index) || index < 0 || index >= currentValue.length) {
                return undefined;
            }
            currentValue = currentValue[index];
            continue;
        }

        if (!isPlainObject(currentValue) || !Object.prototype.hasOwnProperty.call(currentValue, segment)) {
            return undefined;
        }

        currentValue = currentValue[segment];
    }

    return currentValue;
}

function stringifyEnvironmentValue(value) {
    if (value === undefined || value === null) {
        return '';
    }

    if (typeof value === 'string') {
        return value;
    }

    return JSON.stringify(value);
}

function interpolateValue(value, variables) {
    return String(value || '').replace(/{{\s*([^{}\s]+)\s*}}/g, (_, key) => {
        const resolved = resolveEnvironmentValue(variables, key);
        return resolved === undefined || resolved === null ? '' : stringifyEnvironmentValue(resolved);
    });
}

function activeVariablesFor(environmentState, activeEnvironment) {
    if (isPlainObject(activeEnvironment?.variables) && Object.prototype.hasOwnProperty.call(activeEnvironment.variables, BASE_ENVIRONMENT_PREFIX)) {
        return activeEnvironment.variables;
    }

    const normalizedState = normalizeEnvironmentsState(environmentState);
    const environmentId = activeEnvironment?.id || normalizedState.active_environment_id;
    const selected = normalizedState.environments.find((environment) => environment.id === environmentId) || normalizedState.environments[0] || null;

    return {
        ...(isPlainObject(selected?.variables) ? selected.variables : {}),
        [BASE_ENVIRONMENT_PREFIX]: isPlainObject(normalizedState.base_environment?.variables) ? normalizedState.base_environment.variables : {},
    };
}

function applyQueryParams(url, queryParams, variables) {
    const target = new URL(interpolateValue(url, variables));

    for (const param of queryParams || []) {
        if (!param?.enabled || !param.key) {
            continue;
        }
        target.searchParams.set(param.key, interpolateValue(param.value, variables));
    }

    return target.toString();
}

function prettifyData(value) {
    if (typeof value === 'string') {
        return value;
    }

    return JSON.stringify(value, null, 2);
}

function sanitizeTokenFieldName(value, fallback) {
    const trimmed = String(value || '').trim();
    return trimmed || fallback;
}

async function performOAuth2TokenRequest(requestConfig) {
    return axios({
        method: 'post',
        url: requestConfig.url,
        data: requestConfig.body.toString(),
        headers: requestConfig.headers,
        httpsAgent: INSECURE_HTTPS_AGENT,
        validateStatus: () => true,
    });
}

function normalizeOAuth2GrantType(grantType) {
    const normalizedGrantType = String(grantType || '')
        .trim()
        .toLowerCase()
        .replace(/[-\s]+/g, '_');

    if (!normalizedGrantType) {
        return 'client_credentials';
    }

    if (normalizedGrantType === 'password' || normalizedGrantType === 'resource_owner_password_credentials' || normalizedGrantType === 'resource_owner_password') {
        return 'password';
    }

    if (normalizedGrantType === 'client_credentials' || normalizedGrantType === 'client_credential') {
        return 'client_credentials';
    }

    if (normalizedGrantType === 'authorization_code' || normalizedGrantType === 'authorization') {
        return 'authorization_code';
    }

    if (normalizedGrantType === 'refresh_token') {
        return 'refresh_token';
    }

    return normalizedGrantType;
}

function normalizeOAuth2ClientAuthentication(clientAuthentication) {
    const normalizedClientAuthentication = String(clientAuthentication || '')
        .trim()
        .toLowerCase()
        .replace(/[-\s]+/g, '_');

    if (normalizedClientAuthentication === 'body' || normalizedClientAuthentication === 'request_body') {
        return 'body';
    }

    return 'basic';
}

function buildOAuth2TokenRequest(oauth2, variables) {
    const config = {
        ...defaultOAuth2(),
        ...(oauth2 || {}),
    };
    const grantType = normalizeOAuth2GrantType(config.grantType);
    const clientAuthentication = normalizeOAuth2ClientAuthentication(config.clientAuthentication);
    const url = interpolateValue(config.accessTokenUrl || '', variables).trim();
    if (!url) {
        throw new Error('OAuth2 access token URL is required.');
    }

    const body = new URLSearchParams();
    body.set('grant_type', grantType);

    const clientId = interpolateValue(config.clientId || '', variables);
    const clientSecret = interpolateValue(config.clientSecret || '', variables);
    const scope = interpolateValue(config.scope || '', variables);
    const audience = interpolateValue(config.audience || '', variables);
    const resource = interpolateValue(config.resource || '', variables);

    if (scope) {
        body.set('scope', scope);
    }
    if (audience) {
        body.set('audience', audience);
    }
    if (resource) {
        body.set('resource', resource);
    }

    if (grantType === 'password') {
        body.set('username', interpolateValue(config.username || '', variables));
        body.set('password', interpolateValue(config.password || '', variables));
    }

    if (grantType === 'authorization_code') {
        const authorizationCode = interpolateValue(config.authorizationCode || '', variables);
        if (!authorizationCode) {
            throw new Error('OAuth2 authorization code is required for the Authorization Code grant.');
        }
        body.set('code', authorizationCode);
        if (config.redirectUri) {
            body.set('redirect_uri', interpolateValue(config.redirectUri, variables));
        }
        if (config.codeVerifier) {
            body.set('code_verifier', interpolateValue(config.codeVerifier, variables));
        }
    }

    const headers = {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json, text/plain, */*',
    } as Record<string, string>;

    if (clientAuthentication === 'body') {
        if (clientId) {
            body.set('client_id', clientId);
        }
        if (clientSecret) {
            body.set('client_secret', clientSecret);
        }
    } else if (clientId || clientSecret) {
        headers.Authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`, 'utf8').toString('base64')}`;
    }

    return { url, body, headers };
}

function describeRequestExecutionError(error) {
    const fallback = {
        stage: 'request-setup',
        title: 'Request could not be sent',
        summary: 'The request failed before an HTTP response was received.',
        detail: error?.message || 'Unknown error.',
        suggestion: 'Check the request URL, authentication, and local network connectivity.',
        code: '',
    };

    if (!error) {
        return fallback;
    }

    if (axios.isAxiosError?.(error)) {
        const code = String(error.code || '');
        const aggregate = error.cause instanceof AggregateError || /AggregateError/i.test(String(error.message || ''));

        if (error.response) {
            return {
                stage: 'response-error',
                title: 'Server responded with an error',
                summary: `The server returned HTTP ${error.response.status}.`,
                detail: error.message || 'The server responded with an error status.',
                suggestion: 'Inspect the response body and headers for server-side error details.',
                code,
            };
        }

        if (error.request) {
            if (code === 'ECONNREFUSED') {
                return {
                    stage: 'no-response',
                    title: 'Request was sent, but the connection was refused',
                    summary: 'No server accepted the connection.',
                    detail: 'The target host actively refused the TCP connection. The server may be offline, the port may be wrong, or nothing is listening there.',
                    suggestion: 'Verify the host, port, and whether the target service is running.',
                    code,
                };
            }

            if (code === 'ENOTFOUND') {
                return {
                    stage: 'no-response',
                    title: 'Request was sent, but the host name could not be resolved',
                    summary: 'DNS lookup failed before reaching the server.',
                    detail: 'The hostname could not be resolved to an IP address.',
                    suggestion: 'Check the URL host name and any environment variables used in it.',
                    code,
                };
            }

            if (code === 'ETIMEDOUT' || code === 'ECONNABORTED') {
                return {
                    stage: 'no-response',
                    title: 'Request was sent, but the server did not respond in time',
                    summary: 'The connection timed out before a response arrived.',
                    detail: error.message || 'The request timed out.',
                    suggestion: 'Try again, or check whether the target server is slow or unreachable.',
                    code,
                };
            }

            if (aggregate) {
                return {
                    stage: 'no-response',
                    title: 'Request was sent, but no network path succeeded',
                    summary: 'Multiple connection attempts failed before a response was received.',
                    detail: error.message || 'The runtime tried several addresses and all connection attempts failed.',
                    suggestion: 'Check the URL host, port, proxy/VPN settings, and whether the target service is reachable from this machine.',
                    code,
                };
            }

            return {
                stage: 'no-response',
                title: 'Request was sent, but no response was received',
                summary: 'The request left the client, but no HTTP response came back.',
                detail: error.message || 'No response was received from the server.',
                suggestion: 'Check the target service, local network access, firewall, and proxy configuration.',
                code,
            };
        }

        return {
            stage: 'request-setup',
            title: 'Request could not be sent',
            summary: 'The request failed while being prepared on the client.',
            detail: error.message || 'The request could not be prepared.',
            suggestion: 'Check the request URL, headers, body, and authentication values.',
            code,
        };
    }

    if (/Invalid URL/i.test(String(error.message || ''))) {
        return {
            stage: 'request-setup',
            title: 'Request was not sent because the URL is invalid',
            summary: 'The URL could not be parsed into a valid HTTP request target.',
            detail: 'Use a full URL such as http://localhost:3000 or https://api.example.com.',
            suggestion: 'Check the URL field and any environment variables used inside it.',
            code: '',
        };
    }

    if (/empty/i.test(String(error.message || '')) && /url/i.test(String(error.message || ''))) {
        return {
            stage: 'request-setup',
            title: 'Request was not sent because the URL is empty',
            summary: 'A request target is required before sending.',
            detail: 'The URL field is empty after environment variable interpolation.',
            suggestion: 'Enter a URL or verify the variables used in the URL field.',
            code: '',
        };
    }

    return fallback;
}

function buildRequestFailureResponse(error, context) {
    const description = describeRequestExecutionError(error);

    return {
        ok: false,
        hasResponse: false,
        status: 'ERROR',
        statusText: description.title,
        headers: {},
        data: description.detail,
        durationMs: Date.now() - context.startedAt,
        requestPreview: {
            url: context.finalUrl || '',
            headers: context.headers || {},
            body: typeof context.data === 'string' ? context.data : context.data ? JSON.stringify(context.data, null, 2) : '',
        },
        error: description,
    };
}

function normalizeCurlShellTarget(target) {
    if (target === 'cmd' || target === 'bash') {
        return target;
    }

    return 'powershell';
}

function quotePowerShellArgument(value) {
    const stringValue = String(value ?? '');
    return `'${stringValue.replace(/'/g, "''")}'`;
}

function quotePosixArgument(value) {
    const stringValue = String(value ?? '');
    return `'${stringValue.replace(/'/g, `'"'"'`)}'`;
}

function quoteCmdArgument(value) {
    const stringValue = String(value ?? '');
    if (!stringValue) {
        return '""';
    }

    let result = '"';
    let backslashCount = 0;

    for (const character of stringValue) {
        if (character === '\\') {
            backslashCount += 1;
            continue;
        }

        if (character === '"') {
            result += `${'\\'.repeat(backslashCount * 2 + 1)}\"`;
            backslashCount = 0;
            continue;
        }

        result += `${'\\'.repeat(backslashCount)}${character}`;
        backslashCount = 0;
    }

    result += `${'\\'.repeat(backslashCount * 2)}\"`;
    return result;
}

function quoteShellArgument(value, target) {
    const normalizedTarget = normalizeCurlShellTarget(target);

    if (normalizedTarget === 'cmd') {
        return quoteCmdArgument(value);
    }

    if (normalizedTarget === 'bash') {
        return quotePosixArgument(value);
    }

    return quotePowerShellArgument(value);
}

function formatCurlCommand(parts, target) {
    const normalizedTarget = normalizeCurlShellTarget(target);
    const continuation = normalizedTarget === 'cmd' ? ' ^' : normalizedTarget === 'bash' ? ' \\' : ' `';
    return parts.map((part, index) => (index === parts.length - 1 ? part : `${part}${continuation}`)).join('\n');
}

function commandNameForTarget(target) {
    return normalizeCurlShellTarget(target) === 'bash' ? 'curl' : 'curl.exe';
}

function requestMethodSupportsBody(method) {
    const normalizedMethod = String(method || '').trim().toLowerCase();
    return normalizedMethod !== 'get' && normalizedMethod !== 'head';
}

function hasHeader(headers, headerName) {
    const normalizedHeaderName = String(headerName || '').trim().toLowerCase();
    return Object.keys(headers || {}).some((key) => key.trim().toLowerCase() === normalizedHeaderName);
}

function resolveRequestBody(body, variables, method) {
    const bodyType = String(body?.type || '').trim().toLowerCase();
    const content = typeof body?.content === 'string' ? interpolateValue(body.content, variables) : '';

    if (bodyType === 'json') {
        const trimmedContent = content.trim();

        if (!trimmedContent) {
            if (!requestMethodSupportsBody(method)) {
                return {
                    hasBody: false,
                    data: undefined,
                    preview: '',
                    curlBody: '',
                    contentType: 'application/json',
                };
            }

            return {
                hasBody: true,
                data: {},
                preview: '{}',
                curlBody: '{}',
                contentType: 'application/json',
            };
        }

        try {
            const parsed = JSON.parse(content);
            return {
                hasBody: true,
                data: parsed,
                preview: JSON.stringify(parsed, null, 2),
                curlBody: JSON.stringify(parsed),
                contentType: 'application/json',
            };
        } catch {
            return {
                hasBody: true,
                data: content,
                preview: content,
                curlBody: content,
                contentType: 'application/json',
            };
        }
    }

    if (!content) {
        return {
            hasBody: false,
            data: undefined,
            preview: '',
            curlBody: '',
            contentType: '',
        };
    }

    return {
        hasBody: true,
        data: content,
        preview: content,
        curlBody: content,
        contentType: '',
    };
}

function buildCurlCommand(request, activeEnvironment, target = 'powershell') {
    const normalizedTarget = normalizeCurlShellTarget(target);
    const variables = activeVariablesFor({ environments: [activeEnvironment], active_environment_id: activeEnvironment?.id }, activeEnvironment);
    const method = String(request?.method || 'GET').toUpperCase();
    const headers = {} as Record<string, string>;

    for (const header of request?.headers || []) {
        if (header?.enabled && header.key) {
            headers[header.key] = interpolateValue(header.value, variables);
        }
    }

    const auth = request?.auth || { type: 'none' };
    let basicCredentials = '';

    if (auth.type === 'bearer' && auth.bearerToken) {
        headers.Authorization = `Bearer ${interpolateValue(auth.bearerToken, variables)}`;
    }

    if (auth.type === 'basic' && (auth.username || auth.password)) {
        const username = interpolateValue(auth.username || '', variables);
        const password = interpolateValue(auth.password || '', variables);
        basicCredentials = `${username}:${password}`;
    }

    let finalUrl = interpolateValue(request?.url || '', variables).trim();
    if (!finalUrl) {
        throw new Error('Request URL is empty.');
    }

    const hasEnabledParams = (request?.query_params || []).some((param) => param?.enabled && param.key);
    finalUrl = hasEnabledParams ? applyQueryParams(finalUrl, request.query_params, variables) : new URL(finalUrl).toString();

    if (auth.type === 'oauth2') {
        const oauth2 = {
            ...defaultOAuth2(),
            ...(auth.oauth2 || {}),
        };
        const accessToken = interpolateValue(oauth2.accessToken || '', variables);
        const tokenPrefix = sanitizeTokenFieldName(interpolateValue(oauth2.tokenPrefix || 'Bearer', variables), 'Bearer');
        const addTokenTo = oauth2.addTokenTo || 'request_header';
        const tokenFieldName = sanitizeTokenFieldName(interpolateValue(oauth2.tokenParameterName || '', variables), addTokenTo === 'query' ? 'access_token' : 'Authorization');

        if (accessToken) {
            if (addTokenTo === 'query') {
                const target = new URL(finalUrl);
                target.searchParams.set(tokenFieldName, accessToken);
                finalUrl = target.toString();
            } else if (tokenFieldName.toLowerCase() === 'authorization') {
                headers[tokenFieldName] = `${tokenPrefix} ${accessToken}`.trim();
            } else {
                headers[tokenFieldName] = accessToken;
            }
        }
    }

    const resolvedBody = resolveRequestBody(request?.body, variables, method);
    if (resolvedBody.contentType && resolvedBody.hasBody && !hasHeader(headers, 'content-type')) {
        headers['Content-Type'] = resolvedBody.contentType;
    }

    const commandParts = [[commandNameForTarget(normalizedTarget)], ['--request', method], ['--url', quoteShellArgument(finalUrl, normalizedTarget)]];

    for (const [headerName, headerValue] of Object.entries(headers)) {
        commandParts.push(['--header', quoteShellArgument(`${headerName}: ${headerValue}`, normalizedTarget)]);
    }

    if (basicCredentials) {
        commandParts.push(['--user', quoteShellArgument(basicCredentials, normalizedTarget)]);
    }

    if (resolvedBody.hasBody) {
        commandParts.push(['--data-raw', quoteShellArgument(resolvedBody.curlBody, normalizedTarget)]);
    }

    return formatCurlCommand(commandParts.map((segment) => segment.join(' ')), normalizedTarget);
}

function clampZoomLevel(zoomLevel) {
    return Math.min(MAX_ZOOM_LEVEL, Math.max(MIN_ZOOM_LEVEL, zoomLevel));
}

function adjustWindowZoom(webContents, delta) {
    const currentZoomLevel = webContents.getZoomLevel();
    const nextZoomLevel = clampZoomLevel(currentZoomLevel + delta);

    if (nextZoomLevel !== currentZoomLevel) {
        webContents.setZoomLevel(nextZoomLevel);
        emitZoomChanged(BrowserWindow.fromWebContents(webContents));
    }
}

function installZoomShortcuts(mainWindow) {
    mainWindow.webContents.on('before-input-event', (event, input) => {
        const hasPrimaryModifier = input.control || input.meta;
        if (!hasPrimaryModifier || input.alt) {
            return;
        }

        if (input.code === 'Equal' || input.code === 'NumpadAdd' || input.key === '+') {
            event.preventDefault();
            adjustWindowZoom(mainWindow.webContents, 1);
            return;
        }

        if (input.code === 'Minus' || input.code === 'NumpadSubtract' || input.key === '-') {
            event.preventDefault();
            adjustWindowZoom(mainWindow.webContents, -1);
            return;
        }

        if (input.code === 'Digit0' || input.code === 'Numpad0' || input.key === '0') {
            event.preventDefault();
            mainWindow.webContents.setZoomLevel(0);
            emitZoomChanged(mainWindow);
        }
    });
}

async function createWindow() {
    const packagedResourcesPath = path.join(path.dirname(process.execPath), 'resources');
    const iconPath = process.platform === 'linux'
        ? (app.isPackaged
            ? path.join(packagedResourcesPath, 'icon.png')
            : path.join(__dirname, '../../build/icon.png'))
        : process.platform === 'win32'
            ? (app.isPackaged
                ? path.join(packagedResourcesPath, 'icon.ico')
                : path.join(__dirname, '../../build/icon.ico'))
            : null;

    if (iconPath && !fsSync.existsSync(iconPath)) {
        console.warn(`[icons] Window icon file not found: ${iconPath}`);
    }

    const mainWindow = new BrowserWindow({
        width: 1560,
        height: 980,
        minWidth: 1180,
        minHeight: 760,
        backgroundColor: '#f5efe5',
        frame: false,
        autoHideMenuBar: true,
        show: false,
        icon: iconPath && fsSync.existsSync(iconPath) ? iconPath : undefined,
        webPreferences: {
            preload: path.join(__dirname, 'preload.cjs'),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });

    mainWindow.removeMenu();
    mainWindow.setMenuBarVisibility(false);

    mainWindow.webContents.on('console-message', (_, details) => {
        const source = details?.sourceId || 'renderer';
        const line = details?.lineNumber ?? 0;
        const level = typeof details?.level === 'number' ? details.level : 1;
        const levelLabel = ['debug', 'info', 'warn', 'error'][level] || `level-${level}`;
        console.log(`[renderer:${levelLabel}] ${source}:${line} ${details?.message || ''}`);
    });

    mainWindow.webContents.on('render-process-gone', (_, details) => {
        console.error('[renderer:gone]', details);
    });

    mainWindow.webContents.on('unresponsive', () => {
        console.error('[renderer:unresponsive] Window became unresponsive');
    });

    mainWindow.webContents.on('did-fail-load', (_, errorCode, errorDescription, validatedURL) => {
        console.error('[renderer:load-failed]', { errorCode, errorDescription, validatedURL });
    });

    installZoomShortcuts(mainWindow);

    const publishState = () => emitWindowState(mainWindow);
    mainWindow.on('maximize', publishState);
    mainWindow.on('unmaximize', publishState);
    mainWindow.on('minimize', publishState);
    mainWindow.on('restore', publishState);

    mainWindow.once('ready-to-show', () => {
        publishState();
        mainWindow.show();
    });

    if (process.env.VITE_DEV_SERVER_URL) {
        await mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
    } else {
        await mainWindow.loadFile(path.join(app.getAppPath(), 'dist', 'index.html'));
    }
}

app.whenReady().then(() => {
    app.setAppUserModelId(WINDOWS_APP_ID);
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

ipcMain.handle('workspace:list', async () => {
    const workspaces = await ensureManagedDefaultWorkspace();
    return {
        workspaces,
        workspacesRootPath: getManagedWorkspacesRootPath(),
    };
});

ipcMain.handle('window:get-state', (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) {
        return { isMaximized: false, isMinimized: false };
    }

    return serializeWindowState(window);
});

ipcMain.handle('window:minimize', (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    window?.minimize();
    return true;
});

ipcMain.handle('window:toggle-maximize', (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) {
        return { isMaximized: false, isMinimized: false };
    }

    if (window.isFullScreen()) {
        window.setFullScreen(false);
        window.maximize();
    } else if (window.isMaximized()) {
        window.unmaximize();
    } else {
        window.maximize();
    }

    const state = serializeWindowState(window);
    emitWindowState(window);
    return state;
});

ipcMain.handle('window:close', (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    window?.close();
    return true;
});

ipcMain.handle('workspace:load', async (_, workspacePath) => buildManagedWorkspaceSnapshot(workspacePath));

ipcMain.handle('workspace:open', async (_, workspaceId) => {
    const workspace = await findManagedWorkspaceById(workspaceId);
    if (!workspace) {
        throw new Error('Workspace could not be found.');
    }

    return buildManagedWorkspaceSnapshot(workspace.path);
});

ipcMain.handle('workspace:bootstrap', async () => bootstrapManagedWorkspace());

ipcMain.handle('workspace:create', async (_, { name }) => {
    const trimmedName = String(name || '').trim();
    if (!trimmedName) {
        throw new Error('Workspace name is required.');
    }

    const workspacePath = await ensureUniqueWorkspaceDirectoryPath(trimmedName);
    await ensureWorkspaceReady(workspacePath, { workspaceName: trimmedName });
    return buildManagedWorkspaceSnapshot(workspacePath);
});

ipcMain.handle('workspace:rename', async (_, { workspaceId, name }) => {
    const normalizedWorkspaceId = String(workspaceId || '').trim();
    const trimmedName = String(name || '').trim();

    if (!normalizedWorkspaceId) {
        throw new Error('Workspace id is required.');
    }

    if (!trimmedName) {
        throw new Error('Workspace name is required.');
    }

    const workspace = await findManagedWorkspaceById(normalizedWorkspaceId);
    if (!workspace) {
        throw new Error('Workspace could not be found.');
    }

    const metadata = await loadWorkspaceMetadata(workspace.path);
    await writeJson(path.join(workspace.path, WORKSPACE_METADATA_FILE), {
        ...metadata,
        workspace_id: metadata.workspace_id || workspace.id,
        workspace_name: trimmedName,
    });

    const workspaces = await ensureManagedDefaultWorkspace();
    const workspaceState = await loadWorkspaceState();
    const activeWorkspace = workspaces.find((item) => item.id === workspaceState.active_workspace_id) || workspaces.find((item) => item.id === normalizedWorkspaceId) || workspaces[0];
    return buildManagedWorkspaceSnapshot(activeWorkspace.path);
});

ipcMain.handle('workspace:delete', async (_, { workspaceId }) => {
    const workspace = await findManagedWorkspaceById(workspaceId);
    if (!workspace) {
        throw new Error('Workspace could not be found.');
    }

    await fs.rm(workspace.path, { recursive: true, force: true });
    const remainingWorkspaces = await ensureManagedDefaultWorkspace();
    const nextActiveWorkspace = remainingWorkspaces.find((item) => item.id !== workspaceId) || remainingWorkspaces[0];
    return buildManagedWorkspaceSnapshot(nextActiveWorkspace.path);
});

ipcMain.handle('workspace:save-ui-state', async (_, { workspaceId, uiState }) => {
    const normalizedWorkspaceId = String(workspaceId || '').trim();
    if (!normalizedWorkspaceId) {
        throw new Error('Workspace id is required.');
    }

    const workspaces = await ensureManagedDefaultWorkspace();
    if (!workspaces.some((workspace) => workspace.id === normalizedWorkspaceId)) {
        throw new Error('Workspace could not be found.');
    }

    const workspaceState = await loadWorkspaceState();
    await saveWorkspaceState({
        ...workspaceState,
        workspace_ui_state_by_id: {
            ...workspaceState.workspace_ui_state_by_id,
            [normalizedWorkspaceId]: normalizeWorkspaceUiState(uiState),
        },
    });

    return true;
});

ipcMain.handle('workspace:import', async (_, payload: { source?: string } = {}) => {
    const importSource = String(payload.source || 'requii').toLowerCase();
    const dialogResult = await dialog.showOpenDialog({
        properties: ['openFile'],
        filters: importSource === 'insomnia'
            ? [{ name: 'Insomnia Collection Export', extensions: ['yaml', 'yml', 'json'] }]
            : [{ name: 'JSON', extensions: ['json'] }],
    });

    if (dialogResult.canceled || !dialogResult.filePaths[0]) {
        return null;
    }

    const importedPayload = importSource === 'insomnia'
        ? parseInsomniaExport(await readText(dialogResult.filePaths[0]), dialogResult.filePaths[0])
        : await readJson(dialogResult.filePaths[0]);
    const importedWorkspaceName = String(importedPayload?.workspace_name || path.parse(dialogResult.filePaths[0]).name || 'Imported Workspace').trim() || 'Imported Workspace';
    const importedWorkspaceId = typeof importedPayload?.workspace_id === 'string' && importedPayload.workspace_id.trim() ? importedPayload.workspace_id.trim() : '';

    if (importedWorkspaceId) {
        const existingWorkspace = await findManagedWorkspaceById(importedWorkspaceId);
        if (existingWorkspace) {
            await mergeImportedWorkspaceById(existingWorkspace.path, importedPayload);
            return buildManagedWorkspaceSnapshot(existingWorkspace.path);
        }
    }

    const workspacePath = await ensureUniqueWorkspaceDirectoryPath(importedWorkspaceName);
    await ensureWorkspaceReady(workspacePath, { workspaceName: importedWorkspaceName, workspaceId: importedWorkspaceId || undefined });
    await importPayloadIntoWorkspace(workspacePath, importedPayload);
    return buildManagedWorkspaceSnapshot(workspacePath);
});

ipcMain.handle('workspace:open-folder', async (_, { workspacePath }) => {
    const targetPath = String(workspacePath || '').trim();
    if (!targetPath) {
        throw new Error('Workspace path is required.');
    }

    const errorMessage = await shell.openPath(targetPath);
    if (errorMessage) {
        throw new Error(errorMessage);
    }

    return true;
});

ipcMain.handle('folder:create', async (_, { workspacePath, parentPath, folderName }) => {
    const folderSegment = sanitizeSegment(folderName);
    const targetRelativePath = cleanRelativePath(path.posix.join(cleanRelativePath(parentPath), folderSegment));
    await fs.mkdir(path.join(workspacePath, targetRelativePath), { recursive: true });
    return buildManagedWorkspaceSnapshot(workspacePath);
});

ipcMain.handle('folder:rename', async (_, { workspacePath, folderPath, nextName }) => {
    const sourcePath = cleanRelativePath(folderPath);
    if (!sourcePath) {
        throw new Error('Cannot rename the workspace root.');
    }

    const folderSegment = sanitizeSegment(nextName);
    const parentPath = folderParentPath(sourcePath);
    const destinationPath = cleanRelativePath(path.posix.join(parentPath, folderSegment));

    if (!destinationPath) {
        throw new Error('Invalid folder name.');
    }

    if (destinationPath === sourcePath) {
        return loadWorkspaceSnapshot(workspacePath);
    }

    if (await fileExists(path.join(workspacePath, destinationPath))) {
        throw new Error(`A folder named ${folderSegment} already exists here.`);
    }

    const metadata = await loadWorkspaceMetadata(workspacePath);

    await fs.rename(path.join(workspacePath, sourcePath), path.join(workspacePath, destinationPath));
    await writeJson(path.join(workspacePath, WORKSPACE_METADATA_FILE), {
        ...metadata,
        folder_order: remapFolderOrder(metadata.folder_order || [], sourcePath, destinationPath),
        folders: remapFolderRecords(metadata.folders || [], sourcePath, destinationPath),
    });

    return buildManagedWorkspaceSnapshot(workspacePath);
});

ipcMain.handle('folder:move', async (_, { workspacePath, folderPath, targetParentPath, insertIndex }) => {
    const sourcePath = cleanRelativePath(folderPath);
    const destinationParentPath = cleanRelativePath(targetParentPath);

    if (!sourcePath) {
        throw new Error('Cannot move the workspace root.');
    }

    if (destinationParentPath === sourcePath || destinationParentPath.startsWith(`${sourcePath}/`)) {
        throw new Error('Cannot move a folder into itself or one of its descendants.');
    }

    const snapshot = await loadWorkspaceSnapshot(workspacePath);
    const nextFolderOrder = reorderFolderPaths(snapshot.folders || [], sourcePath, destinationParentPath, insertIndex);
    const currentParentPath = folderParentPath(sourcePath);
    const nextPath = cleanRelativePath(path.posix.join(destinationParentPath, folderNameFromPath(sourcePath)));

    if (nextPath !== sourcePath) {
        if ((snapshot.folders || []).includes(nextPath)) {
            throw new Error(`A folder named ${folderNameFromPath(sourcePath)} already exists in the destination.`);
        }

        await fs.mkdir(path.join(workspacePath, destinationParentPath), { recursive: true });
        await fs.rename(path.join(workspacePath, sourcePath), path.join(workspacePath, nextPath));
    }

    const metadata = await loadWorkspaceMetadata(workspacePath);
    await writeJson(path.join(workspacePath, WORKSPACE_METADATA_FILE), {
        workspace_id: snapshot.workspaceId || '',
        workspace_name: snapshot.workspaceName || folderNameFromPath(workspacePath) || DEFAULT_WORKSPACE_NAME,
        folder_order: nextFolderOrder,
        folders: remapFolderRecords(metadata.folders || [], sourcePath, nextPath),
    });

    return buildManagedWorkspaceSnapshot(workspacePath);
});

ipcMain.handle('folder:delete', async (_, { workspacePath, folderPath }) => {
    const targetRelativePath = cleanRelativePath(folderPath);
    if (!targetRelativePath) {
        throw new Error('Cannot delete the workspace root.');
    }

    await fs.rm(path.join(workspacePath, targetRelativePath), { recursive: true, force: true });
    const metadata = await loadWorkspaceMetadata(workspacePath);
    await writeJson(path.join(workspacePath, WORKSPACE_METADATA_FILE), {
        ...metadata,
        folder_order: (metadata.folder_order || []).filter((folderPath) => folderPath !== targetRelativePath && !folderPath.startsWith(`${targetRelativePath}/`)),
        folders: pruneFolderRecords(metadata.folders || [], targetRelativePath),
    });
    return buildManagedWorkspaceSnapshot(workspacePath);
});

ipcMain.handle('request:create', async (_, { workspacePath, parentPath, name }) => {
    const request = defaultRequest(name || 'Untitled Request');
    const targetRelativePath = await ensureUniqueRelativePath(
        workspacePath,
        cleanRelativePath(path.posix.join(cleanRelativePath(parentPath), buildRequestFileName(request.name))),
    );

    await writeJson(path.join(workspacePath, targetRelativePath), serializeRequest(request));
    return normalizeRequestPayload(request, targetRelativePath);
});

ipcMain.handle('request:delete', async (_, { workspacePath, request }) => {
    const normalized = normalizeRequestPayload(request, request.filePath || '');
    const targetRelativePath = cleanRelativePath(normalized.filePath || path.posix.join(normalized.path || '', buildRequestFileName(normalized.name)));
    if (!targetRelativePath) {
        throw new Error('Unable to determine request file path.');
    }

    await fs.rm(path.join(workspacePath, targetRelativePath), { force: true });
    return buildManagedWorkspaceSnapshot(workspacePath);
});

ipcMain.handle('request:save', async (_, { workspacePath, request }) => {
    const normalized = normalizeRequestPayload(request, request.filePath || '');
    const currentRelativePath = cleanRelativePath(normalized.filePath || path.posix.join(normalized.path || '', buildRequestFileName(normalized.name)));
    const desiredRelativePath = cleanRelativePath(path.posix.join(normalized.path || '', buildRequestFileName(normalized.name)));
    const finalRelativePath = await ensureUniqueRelativePath(workspacePath, desiredRelativePath, currentRelativePath);

    if (currentRelativePath && currentRelativePath !== finalRelativePath) {
        await fs.mkdir(path.dirname(path.join(workspacePath, finalRelativePath)), { recursive: true });
        if (await fileExists(path.join(workspacePath, currentRelativePath))) {
            await fs.rename(path.join(workspacePath, currentRelativePath), path.join(workspacePath, finalRelativePath));
        }
    }

    await writeJson(path.join(workspacePath, finalRelativePath), serializeRequest(normalized));
    return normalizeRequestPayload(normalized, finalRelativePath);
});

ipcMain.handle('workspace:replace-structure', async (_, { workspacePath, payload }) => {
    return replaceWorkspaceStructure(workspacePath, payload);
});

ipcMain.handle('environment:save', async (_, { workspacePath, environments }) => {
    const normalizedEnvironments = normalizeEnvironmentsState(environments);
    await writeJson(path.join(workspacePath, ENVIRONMENTS_FILE), normalizedEnvironments);
    return normalizedEnvironments;
});

ipcMain.handle('oauth2:fetch-token', async (_, { oauth2, activeEnvironment }) => {
    const variables = activeVariablesFor({ environments: [activeEnvironment], active_environment_id: activeEnvironment?.id }, activeEnvironment);
    const requestConfig = buildOAuth2TokenRequest(oauth2, variables);
    const response = await performOAuth2TokenRequest(requestConfig);

    if (response.status >= 400) {
        throw new Error(`OAuth2 token request failed with HTTP ${response.status}. ${prettifyData(response.data)}`);
    }

    const payload = typeof response.data === 'object' && response.data ? response.data : {};
    const accessToken = String(payload.access_token || '');
    if (!accessToken) {
        throw new Error(`OAuth2 token response did not include an access_token. ${prettifyData(response.data)}`);
    }

    return {
        accessToken,
        tokenType: String(payload.token_type || ''),
        raw: prettifyData(response.data),
    };
});

ipcMain.handle('request:execute', async (_, { request, activeEnvironment }) => {
    const variables = activeVariablesFor({ environments: [activeEnvironment], active_environment_id: activeEnvironment?.id }, activeEnvironment);
    const startedAt = Date.now();
    const method = String(request.method || 'GET').toLowerCase();
    const headers = {} as Record<string, string>;

    for (const header of request.headers || []) {
        if (header?.enabled && header.key) {
            headers[header.key] = interpolateValue(header.value, variables);
        }
    }

    const auth = request.auth || { type: 'none' };
    if (auth.type === 'bearer' && auth.bearerToken) {
        headers.Authorization = `Bearer ${interpolateValue(auth.bearerToken, variables)}`;
    }

    if (auth.type === 'basic' && (auth.username || auth.password)) {
        const username = interpolateValue(auth.username || '', variables);
        const password = interpolateValue(auth.password || '', variables);
        headers.Authorization = `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
    }

    let finalUrl = '';
    let data;

    try {
        finalUrl = interpolateValue(request.url, variables).trim();
        if (!finalUrl) {
            throw new Error('Request URL is empty.');
        }

        const hasEnabledParams = (request.query_params || []).some((param) => param?.enabled && param.key);
        if (hasEnabledParams) {
            finalUrl = applyQueryParams(finalUrl, request.query_params, variables);
        } else {
            finalUrl = new URL(finalUrl).toString();
        }

        if (auth.type === 'oauth2') {
            const oauth2 = {
                ...defaultOAuth2(),
                ...(auth.oauth2 || {}),
            };
            const accessToken = interpolateValue(oauth2.accessToken || '', variables);
            const tokenPrefix = sanitizeTokenFieldName(interpolateValue(oauth2.tokenPrefix || 'Bearer', variables), 'Bearer');
            const addTokenTo = oauth2.addTokenTo || 'request_header';
            const tokenFieldName = sanitizeTokenFieldName(interpolateValue(oauth2.tokenParameterName || '', variables), addTokenTo === 'query' ? 'access_token' : 'Authorization');

            if (accessToken) {
                if (addTokenTo === 'query') {
                    const target = new URL(finalUrl);
                    target.searchParams.set(tokenFieldName, accessToken);
                    finalUrl = target.toString();
                } else if (tokenFieldName.toLowerCase() === 'authorization') {
                    headers[tokenFieldName] = `${tokenPrefix} ${accessToken}`.trim();
                } else {
                    headers[tokenFieldName] = accessToken;
                }
            }
        }

        const resolvedBody = resolveRequestBody(request.body, variables, method);
        if (resolvedBody.contentType && resolvedBody.hasBody && !hasHeader(headers, 'content-type')) {
            headers['Content-Type'] = resolvedBody.contentType;
        }

        if (resolvedBody.hasBody) {
            data = resolvedBody.data;
        }

        const response = await axios({
            method,
            url: finalUrl,
            headers,
            data,
            httpsAgent: INSECURE_HTTPS_AGENT,
            validateStatus: () => true,
        });

        return {
            ok: true,
            hasResponse: true,
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
            data: prettifyData(response.data),
            durationMs: Date.now() - startedAt,
            requestPreview: {
                url: finalUrl,
                headers,
                body: resolvedBody.preview,
            },
            error: null,
        };
    } catch (error) {
        return buildRequestFailureResponse(error, { startedAt, finalUrl, headers, data });
    }
});

ipcMain.handle('request:copy-curl', async (_, { request, activeEnvironment, target }) => {
    const command = buildCurlCommand(request, activeEnvironment, target);
    return command;
});

ipcMain.handle('export:workspace', async (_, { workspacePath, selection }) => {
    const snapshot = await loadWorkspaceSnapshot(workspacePath);
    const metadata = await loadWorkspaceMetadata(workspacePath);
    const payload = buildWorkspaceExportPayload(snapshot, metadata, selection);

    const exportWorkspaceName = payload.workspace_name || snapshot.workspaceName || folderNameFromPath(workspacePath) || DEFAULT_WORKSPACE_NAME;
    const targetFileName = `requii-${safeFileName(exportWorkspaceName)}.json`;
    const target = await dialog.showSaveDialog({
        defaultPath: path.join(workspacePath, targetFileName),
        filters: [{ name: 'JSON', extensions: ['json'] }],
    });

    if (target.canceled || !target.filePath) {
        return null;
    }

    await writeJson(target.filePath, payload);
    return target.filePath;
});

ipcMain.handle('export:request', async (_, { workspacePath, request }) => {
    const payload = serializeRequest(request);
    const target = await dialog.showSaveDialog({
        defaultPath: path.join(workspacePath, `${safeFileName(request.name)}.json`),
        filters: [{ name: 'JSON', extensions: ['json'] }],
    });

    if (target.canceled || !target.filePath) {
        return null;
    }

    await writeJson(target.filePath, payload);
    return target.filePath;
});

ipcMain.handle('import:payload', async (_, { workspacePath }) => {
    const source = await dialog.showOpenDialog({
        properties: ['openFile'],
        filters: [{ name: 'JSON', extensions: ['json'] }],
    });

    if (source.canceled || !source.filePaths[0]) {
        return null;
    }

    const payload = await readJson(source.filePaths[0]);
    await importPayloadIntoWorkspace(workspacePath, payload);
    return buildManagedWorkspaceSnapshot(workspacePath);
});
