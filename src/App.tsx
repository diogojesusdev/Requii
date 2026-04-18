import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CodeMiniEditor } from './components/CodeMiniEditor';
import { EditorTabBar } from './components/EditorTabBar';
import { RequestTabs } from './components/RequestTabs';
import { ResponseBodyDialog, ResponseTabs } from './components/ResponseTabs';
import { TreeSection } from './components/RequestTree';
import { BeautifyIcon, ChevronDownIcon, CloseIcon, DragHandleIcon, ExpandIcon, ExportIcon, FolderIcon, ImportIcon, InvalidStatusIcon, LinkIcon, MaximizeIcon, MinimizeIcon, NewFolderIcon, NewRequestIcon, NewWorkspaceIcon, OpenFolderIcon, PencilIcon, RequestIcon, RestoreIcon, SearchIcon, TerminalIcon, TrashIcon, ValidStatusIcon } from './components/icons';
import {
    COMMON_HEADER_KEY_SUGGESTIONS,
    COMMON_HEADER_VALUE_SUGGESTIONS,
    ENV_AUTOCOMPLETE_MIN_LENGTH,
    EMPTY_ENVIRONMENTS,
    METHOD_OPTIONS,
    PANE_STORAGE_KEY,
    REQUEST_EDITOR_TABS,
    SPLITTER_WIDTH,
} from './constants';
import { requiiIpc } from './services/requii-ipc';
import {
    buildEnvironmentVariableValues,
    getActiveEnvironment,
    getBaseEnvironment,
    getEnvironmentAutocompleteContext,
    getEnvironmentInterpolationMatches,
    getEnvironmentSuggestions,
    listEnvironmentVariableNames,
    normalizeEnvironmentsState,
    renameEnvironmentVariableReferencesInEnvironments,
    renameEnvironmentVariableReferencesInRequest,
    resolveEnvironmentValue,
    stringifyEnvironmentValue,
} from './utils/environment';
import { clampPaneSizes, readStoredPaneSizes } from './utils/pane-layout';
import { createRow, emptyComposer, ensureRequestShape, reorderRequestsCollection } from './utils/request-state';
import { buildTree, filterTree, folderNameFromPath } from './utils/tree';

type CurlTarget = 'powershell' | 'cmd' | 'bash';
type CurlPlatform = 'windows' | 'unix';

const CURL_PLATFORM_OPTIONS: Record<CurlPlatform, { label: string; terminals: Array<{ value: CurlTarget; label: string; language: string }> }> = {
    windows: {
        label: 'Windows',
        terminals: [
            { value: 'powershell', label: 'PowerShell', language: 'powershell' },
            { value: 'cmd', label: 'Command Prompt', language: 'bat' },
        ],
    },
    unix: {
        label: 'macOS / Linux',
        terminals: [{ value: 'bash', label: 'Bash / Zsh', language: 'shell' }],
    },
};

function getDefaultCurlPlatform() {
    if (typeof navigator !== 'undefined' && /win/i.test(navigator.platform || '')) {
        return 'windows' as CurlPlatform;
    }

    return 'unix' as CurlPlatform;
}

function filterRequestStateMap(stateById, validRequestIds) {
    if (!stateById || typeof stateById !== 'object') {
        return {};
    }

    return Object.fromEntries(
        Object.entries(stateById).filter(([requestId, value]) => validRequestIds.has(requestId) && typeof value === 'string'),
    );
}

function isNestedInteractiveElement(target) {
    return target instanceof Element && Boolean(target.closest('button, input, select, textarea, a, label'));
}

function isTextEditingElement(target) {
    return target instanceof Element && Boolean(target.closest('input, textarea, select, [contenteditable="true"], .monaco-editor, .suggest-widget'));
}

function isElementWithinContainer(target, container) {
    return target instanceof Node && container instanceof HTMLElement && container.contains(target);
}

function normalizeExpandedFolderPaths(paths = [], validFolders = []) {
    const validFolderSet = new Set((Array.isArray(validFolders) ? validFolders : []).filter(Boolean));
    return [...new Set((Array.isArray(paths) ? paths : [])
        .map((folderPath) => String(folderPath || '').trim())
        .filter((folderPath) => folderPath && validFolderSet.has(folderPath)))];
}

function remapExpandedFolderPaths(paths = [], sourcePath = '', destinationPath = '') {
    const normalizedSourcePath = String(sourcePath || '').trim();
    const normalizedDestinationPath = String(destinationPath || '').trim();

    return [...new Set((Array.isArray(paths) ? paths : []).map((folderPath) => {
        const normalizedFolderPath = String(folderPath || '').trim();
        if (!normalizedFolderPath) {
            return '';
        }

        if (normalizedFolderPath === normalizedSourcePath) {
            return normalizedDestinationPath;
        }

        if (normalizedSourcePath && normalizedFolderPath.startsWith(`${normalizedSourcePath}/`)) {
            return `${normalizedDestinationPath}${normalizedFolderPath.slice(normalizedSourcePath.length)}`;
        }

        return normalizedFolderPath;
    }).filter(Boolean))];
}

function pruneExpandedFolderPaths(paths = [], targetPath = '') {
    const normalizedTargetPath = String(targetPath || '').trim();
    return [...new Set((Array.isArray(paths) ? paths : []).filter((folderPath) => {
        const normalizedFolderPath = String(folderPath || '').trim();
        return normalizedFolderPath && normalizedFolderPath !== normalizedTargetPath && !normalizedFolderPath.startsWith(`${normalizedTargetPath}/`);
    }))];
}

function collectVisibleFolderPaths(node) {
    if (!node) {
        return [];
    }

    const collectedPaths = [];

    for (const folder of node.folders || []) {
        if (folder?.path) {
            collectedPaths.push(folder.path);
        }

        collectedPaths.push(...collectVisibleFolderPaths(folder));
    }

    return collectedPaths;
}

function App() {
    const layoutRef = useRef(null);
    const workspaceSidebarRef = useRef<HTMLElement | null>(null);
    const requestContentScrollRef = useRef(null);
    const responseSectionRef = useRef(null);
    const authAccessTokenSectionRef = useRef(null);
    const treeScrollRef = useRef(null);
    const pendingTreeRevealRef = useRef(null);
    const dragAutoScrollRef = useRef({ rafId: 0, pointerY: 0 });
    const [workspaceId, setWorkspaceId] = useState('');
    const [workspacePath, setWorkspacePath] = useState('');
    const [workspaceName, setWorkspaceName] = useState('');
    const [workspaces, setWorkspaces] = useState([]);
    const [editingWorkspaceId, setEditingWorkspaceId] = useState(null);
    const [draftWorkspaceName, setDraftWorkspaceName] = useState('');
    const [folders, setFolders] = useState([]);
    const [requests, setRequests] = useState([]);
    const [tabs, setTabs] = useState([]);
    const [draggedTabId, setDraggedTabId] = useState(null);
    const [activeRequestId, setActiveRequestId] = useState('');
    const [environments, setEnvironments] = useState(EMPTY_ENVIRONMENTS);
    const [responses, setResponses] = useState({});
    const [requestEditorTabById, setRequestEditorTabById] = useState({});
    const [responseTabById, setResponseTabById] = useState({});
    const [expandedFolderPaths, setExpandedFolderPaths] = useState([]);
    const [treeFilter, setTreeFilter] = useState('');
    const [urlFilter, setUrlFilter] = useState('');
    const [status, setStatus] = useState('Preparing workspace...');
    const [isBusy, setIsBusy] = useState(false);
    const [isWorkspaceReady, setIsWorkspaceReady] = useState(false);
    const [composer, setComposer] = useState(emptyComposer());
    const [responseViewer, setResponseViewer] = useState(null);
    const [curlViewer, setCurlViewer] = useState(null);
    const [workspaceExportDialog, setWorkspaceExportDialog] = useState(null);
    const [paneSizes, setPaneSizes] = useState(readStoredPaneSizes);
    const [requestDragState, setRequestDragState] = useState(null);
    const [requestDropTarget, setRequestDropTarget] = useState(null);
    const [folderDragState, setFolderDragState] = useState(null);
    const [folderDropTarget, setFolderDropTarget] = useState(null);
    const [windowState, setWindowState] = useState({ isMaximized: false, isMinimized: false });
    const requestSaveTimers = useRef(new Map());
    const requestSaveVersionsRef = useRef(new Map());
    const environmentsSaveTimer = useRef(null);
    const resizeState = useRef(null);
    const requestDropTargetRef = useRef(null);
    const folderDropTargetRef = useRef(null);
    const fileStructureUndoStackRef = useRef([]);
    const fileStructureRedoStackRef = useRef([]);
    const isApplyingFileStructureHistoryRef = useRef(false);
    const isWorkspaceSidebarHoveredRef = useRef(false);

    const activeRequest = requests.find((request) => request.id === activeRequestId) || null;
    const draggedRequestId = requestDragState?.requestId || null;
    const draggedRequest = requests.find((request) => request.id === draggedRequestId) || null;
    const draggedFolderPath = folderDragState?.folderPath || '';
    const draggedFolderName = folderNameFromPath(draggedFolderPath);
    const normalizedEnvironments = useMemo(() => normalizeEnvironmentsState(environments), [environments]);
    const baseEnvironment = useMemo(() => getBaseEnvironment(normalizedEnvironments), [normalizedEnvironments]);
    const activeEnvironment = useMemo(() => getActiveEnvironment(normalizedEnvironments), [normalizedEnvironments]);
    const activeRequestEditorTab = requestEditorTabById[activeRequestId] || 'query';
    const activeResponseTab = responseTabById[activeRequestId] || 'body';
    const activeResponse = activeRequest ? responses[activeRequest.id] : null;
    const visibleTabs = activeRequestId && !tabs.includes(activeRequestId) ? [activeRequestId, ...tabs].slice(0, 12) : tabs;
    const activeEnvironmentVariables = useMemo(() => buildEnvironmentVariableValues(normalizedEnvironments), [normalizedEnvironments]);
    const activeEnvironmentVariableNames = useMemo(() => listEnvironmentVariableNames(activeEnvironmentVariables), [activeEnvironmentVariables]);
    const requestExecutionEnvironment = useMemo(
        () => ({
            ...(activeEnvironment || { id: normalizedEnvironments.active_environment_id || baseEnvironment?.id || '', name: 'Environment' }),
            variables: activeEnvironmentVariables,
        }),
        [activeEnvironment, activeEnvironmentVariables, baseEnvironment?.id, normalizedEnvironments.active_environment_id],
    );
    const tree = useMemo(() => buildTree(folders, requests), [folders, requests]);
    const filteredTree = useMemo(() => filterTree(tree, treeFilter, urlFilter), [tree, treeFilter, urlFilter]);
    const expandedFolderPathSet = useMemo(() => new Set(expandedFolderPaths), [expandedFolderPaths]);

    function getTabSequence(currentTabs = tabs, currentActiveRequestId = activeRequestId) {
        return currentActiveRequestId && !currentTabs.includes(currentActiveRequestId) ? [currentActiveRequestId, ...currentTabs].slice(0, 12) : currentTabs;
    }

    function scrollSectionIntoView(target) {
        if (!target) {
            return;
        }

        window.requestAnimationFrame(() => {
            target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
    }

    function getFolderAncestors(folderPath = '') {
        const normalizedFolderPath = String(folderPath || '').trim();
        if (!normalizedFolderPath) {
            return [];
        }

        const segments = normalizedFolderPath.split('/').filter(Boolean);
        return segments.map((_, index) => segments.slice(0, index + 1).join('/'));
    }

    function ensureTreePathExpanded(folderPath = '') {
        const ancestors = getFolderAncestors(folderPath);
        if (ancestors.length === 0) {
            return;
        }

        setExpandedFolderPaths((previous) => {
            const additions = ancestors.filter((path) => !previous.includes(path));
            return additions.length > 0 ? [...previous, ...additions] : previous;
        });
    }

    function queueTreeReveal(target) {
        pendingTreeRevealRef.current = target;
    }

    function revealTreeTarget(target, behavior = 'smooth') {
        const container = treeScrollRef.current;
        if (!container || !target) {
            return false;
        }

        if (target.type === 'request') {
            ensureTreePathExpanded(target.folderPath || '');
            const element = container.querySelector(`[data-tree-request-id="${target.requestId}"]`);
            if (!element) {
                return false;
            }

            element.scrollIntoView({ behavior, block: 'nearest' });
            return true;
        }

        ensureTreePathExpanded(target.folderPath || '');
        const element = container.querySelector(`[data-tree-folder-path="${target.folderPath}"]`);
        if (!element) {
            return false;
        }

        element.scrollIntoView({ behavior, block: 'nearest' });
        return true;
    }

    function stopTreeAutoScroll() {
        if (dragAutoScrollRef.current.rafId) {
            window.cancelAnimationFrame(dragAutoScrollRef.current.rafId);
        }

        dragAutoScrollRef.current.rafId = 0;
    }

    function updateTreeAutoScrollPointer(pointerY) {
        dragAutoScrollRef.current.pointerY = pointerY;
    }

    function buildFileStructureSnapshot(nextRequests, nextFolders, overrides: any = {}) {
        return {
            requests: nextRequests.map((request) => ensureRequestShape(JSON.parse(JSON.stringify(request)))),
            folders: [...nextFolders],
            expandedFolderPaths: [...(overrides.expandedFolderPaths ?? expandedFolderPaths)],
            activeRequestId: Object.prototype.hasOwnProperty.call(overrides, 'activeRequestId') ? overrides.activeRequestId : activeRequestId,
            tabs: [...(overrides.tabs ?? tabs)],
        };
    }

    function createFileStructureSnapshot(overrides: any = {}) {
        return buildFileStructureSnapshot(overrides.requests || requests, overrides.folders || folders, overrides);
    }

    function pushFileStructureHistory(beforeSnapshot, afterSnapshot) {
        if (isApplyingFileStructureHistoryRef.current) {
            return;
        }

        fileStructureUndoStackRef.current.push({ before: beforeSnapshot, after: afterSnapshot });
        fileStructureRedoStackRef.current = [];
    }

    function buildRequestTabState(nextActiveRequestId, currentTabs = tabs, currentActiveRequestId = activeRequestId) {
        const nextTabs = getTabSequence(currentTabs, currentActiveRequestId);
        const visibleTabs = nextTabs.includes(nextActiveRequestId) ? nextTabs : [...nextTabs, nextActiveRequestId].slice(-12);
        return {
            activeRequestId: nextActiveRequestId,
            tabs: visibleTabs,
        };
    }

    function buildFilteredRequestTabState(nextRequests, currentTabs = tabs, currentActiveRequestId = activeRequestId) {
        const validRequestIds = new Set(nextRequests.map((request) => request.id));
        const filteredTabs = currentTabs.filter((requestId) => validRequestIds.has(requestId)).slice(0, 12);
        const nextActiveId = validRequestIds.has(currentActiveRequestId) ? currentActiveRequestId : filteredTabs[0] || nextRequests[0]?.id || '';
        return {
            activeRequestId: nextActiveId,
            tabs: nextActiveId && !filteredTabs.includes(nextActiveId) ? [nextActiveId, ...filteredTabs].slice(0, 12) : filteredTabs,
        };
    }

    async function restoreFileStructureSnapshot(snapshot, statusMessage) {
        if (!workspacePath || !snapshot) {
            return;
        }

        for (const timer of requestSaveTimers.current.values()) {
            window.clearTimeout(timer);
        }
        requestSaveTimers.current.clear();
        requestSaveVersionsRef.current.clear();

        isApplyingFileStructureHistoryRef.current = true;
        setIsBusy(true);
        setStatus(statusMessage);

        try {
            const restoredSnapshot = await requiiIpc.replaceWorkspaceStructure(workspacePath, {
                folders: snapshot.folders,
                folder_order: snapshot.folders,
                requests: snapshot.requests,
            });
            const validRequestIds = new Set((snapshot.requests || []).map((request) => request.id));
            applySnapshot(restoredSnapshot, { expandedFolderPathsOverride: snapshot.expandedFolderPaths });
            setTabs((snapshot.tabs || []).filter((requestId) => validRequestIds.has(requestId)).slice(0, 12));
            setActiveRequestId(validRequestIds.has(snapshot.activeRequestId) ? snapshot.activeRequestId : (snapshot.tabs || []).find((requestId) => validRequestIds.has(requestId)) || restoredSnapshot.requests?.[0]?.id || '');
        } finally {
            isApplyingFileStructureHistoryRef.current = false;
            setIsBusy(false);
        }
    }

    async function undoFileStructureChange() {
        const entry = fileStructureUndoStackRef.current.pop();
        if (!entry) {
            return;
        }

        fileStructureRedoStackRef.current.push(entry);
        await restoreFileStructureSnapshot(entry.before, 'Undoing file structure change...');
    }

    async function redoFileStructureChange() {
        const entry = fileStructureRedoStackRef.current.pop();
        if (!entry) {
            return;
        }

        fileStructureUndoStackRef.current.push(entry);
        await restoreFileStructureSnapshot(entry.after, 'Redoing file structure change...');
    }

    useEffect(() => {
        let cancelled = false;

        async function bootstrapWorkspace() {
            setIsBusy(true);
            try {
                const snapshot = await requiiIpc.bootstrapWorkspace();
                if (cancelled) {
                    return;
                }
                applySnapshot(snapshot);
                setIsWorkspaceReady(true);
                setStatus(`Workspace ready: ${snapshot.workspace?.name || snapshot.workspaceName || 'Workspace'}.`);
            } catch (error) {
                if (!cancelled) {
                    setStatus(error.message || 'Failed to prepare the default workspace.');
                }
            } finally {
                if (!cancelled) {
                    setIsBusy(false);
                }
            }
        }

        bootstrapWorkspace();

        return () => {
            cancelled = true;
            for (const timer of requestSaveTimers.current.values()) {
                window.clearTimeout(timer);
            }
            if (environmentsSaveTimer.current) {
                window.clearTimeout(environmentsSaveTimer.current);
            }
        };
    }, []);

    useEffect(() => {
        let disposed = false;
        const unsubscribe = requiiIpc.onWindowStateChange((nextState) => {
            if (!disposed) {
                setWindowState(nextState);
            }
        });

        void requiiIpc.getWindowState().then((nextState) => {
            if (!disposed) {
                setWindowState(nextState);
            }
        });

        return () => {
            disposed = true;
            unsubscribe?.();
        };
    }, []);

    useEffect(() => {
        const unsubscribe = requiiIpc.onZoomChange(() => {
            const containerWidth = layoutRef.current?.getBoundingClientRect().width || 0;
            setPaneSizes((previous) => clampPaneSizes(previous, containerWidth));
        });

        return () => {
            unsubscribe?.();
        };
    }, []);

    useEffect(() => {
        if (!workspaceId || !isWorkspaceReady) {
            return;
        }

        const timer = window.setTimeout(() => {
            void requiiIpc
                .saveWorkspaceUiState(workspaceId, {
                    open_request_ids: getTabSequence(tabs, activeRequestId),
                    active_request_id: activeRequestId,
                    request_editor_tab_by_id: requestEditorTabById,
                    response_tab_by_id: responseTabById,
                    expanded_folder_paths: expandedFolderPaths,
                    tree_filter: treeFilter,
                    url_filter: urlFilter,
                })
                .catch(() => {
                    // Ignore persistence failures and keep the current session usable.
                });
        }, 150);

        return () => window.clearTimeout(timer);
    }, [workspaceId, isWorkspaceReady, tabs, activeRequestId, requestEditorTabById, responseTabById, expandedFolderPaths, treeFilter, urlFilter]);

    useEffect(() => {
        const target = pendingTreeRevealRef.current;
        if (!target) {
            return;
        }

        const revealed = revealTreeTarget(target);
        if (revealed) {
            pendingTreeRevealRef.current = null;
        }
    }, [requests, folders, expandedFolderPaths, activeRequestId]);

    useEffect(() => {
        fileStructureUndoStackRef.current = [];
        fileStructureRedoStackRef.current = [];
        requestSaveVersionsRef.current.clear();
    }, [workspaceId]);

    useEffect(() => {
        requestDropTargetRef.current = requestDropTarget;
    }, [requestDropTarget]);

    useEffect(() => {
        folderDropTargetRef.current = folderDropTarget;
    }, [folderDropTarget]);

    useEffect(() => {
        const normalizedFilter = treeFilter.trim();
        const normalizedUrlFilter = urlFilter.trim();
        if (!normalizedFilter && !normalizedUrlFilter) {
            return;
        }

        const visibleFolderPaths = collectVisibleFolderPaths(filteredTree);
        if (visibleFolderPaths.length === 0) {
            return;
        }

        setExpandedFolderPaths((previous) => {
            const nextPaths = [...new Set([...previous, ...visibleFolderPaths])];
            return nextPaths.length === previous.length ? previous : nextPaths;
        });
    }, [filteredTree, treeFilter, urlFilter]);

    useEffect(() => {
        try {
            window.localStorage.setItem(PANE_STORAGE_KEY, JSON.stringify(paneSizes));
        } catch {
            // Ignore localStorage failures.
        }
    }, [paneSizes]);

    useEffect(() => {
        function syncPaneSizesToLayout() {
            const containerWidth = layoutRef.current?.getBoundingClientRect().width || 0;
            setPaneSizes((previous) => clampPaneSizes(previous, containerWidth));
        }

        syncPaneSizesToLayout();

        const resizeObserver = typeof ResizeObserver !== 'undefined' && layoutRef.current
            ? new ResizeObserver(() => {
                syncPaneSizesToLayout();
            })
            : null;

        if (resizeObserver && layoutRef.current) {
            resizeObserver.observe(layoutRef.current);
        }

        window.addEventListener('resize', syncPaneSizesToLayout);
        window.visualViewport?.addEventListener('resize', syncPaneSizesToLayout);

        return () => {
            resizeObserver?.disconnect();
            window.removeEventListener('resize', syncPaneSizesToLayout);
            window.visualViewport?.removeEventListener('resize', syncPaneSizesToLayout);
        };
    }, []);

    useEffect(() => {
        function handlePointerMove(event) {
            if (!resizeState.current || !layoutRef.current) {
                return;
            }

            const containerRect = layoutRef.current.getBoundingClientRect();
            const relativeX = event.clientX - containerRect.left;

            setPaneSizes((previous) => {
                if (resizeState.current?.side === 'left') {
                    return clampPaneSizes({ ...previous, left: relativeX }, containerRect.width);
                }

                const rightWidth = containerRect.right - event.clientX;
                return clampPaneSizes({ ...previous, right: rightWidth }, containerRect.width);
            });
        }

        function stopResize() {
            if (!resizeState.current) {
                return;
            }

            resizeState.current = null;
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
        }

        window.addEventListener('mousemove', handlePointerMove);
        window.addEventListener('mouseup', stopResize);

        return () => {
            window.removeEventListener('mousemove', handlePointerMove);
            window.removeEventListener('mouseup', stopResize);
        };
    }, []);

    useEffect(() => {
        function handleGlobalKeyDown(event) {
            if (event.defaultPrevented) {
                return;
            }

            const hasPrimaryModifier = event.ctrlKey || event.metaKey;
            if (!hasPrimaryModifier || event.altKey) {
                return;
            }

            const normalizedKey = event.key.toLowerCase();
            const textEditingActive = isTextEditingElement(event.target) || isTextEditingElement(document.activeElement);
            const workspaceSidebarOwnsUndo = isWorkspaceSidebarHoveredRef.current
                || isElementWithinContainer(event.target, workspaceSidebarRef.current)
                || isElementWithinContainer(document.activeElement, workspaceSidebarRef.current);

            if (normalizedKey === 'z' && !textEditingActive && workspaceSidebarOwnsUndo) {
                const hasHistory = event.shiftKey ? fileStructureRedoStackRef.current.length > 0 : fileStructureUndoStackRef.current.length > 0;
                if (!hasHistory) {
                    return;
                }

                event.preventDefault();
                if (event.shiftKey) {
                    void redoFileStructureChange();
                    return;
                }

                void undoFileStructureChange();
                return;
            }

            if (textEditingActive) {
                if (event.key !== 'PageUp' && event.key !== 'PageDown') {
                    return;
                }
            } else {
                if (normalizedKey === 'w' && activeRequestId) {
                    event.preventDefault();
                    closeTab(activeRequestId);
                    return;
                }

                if (event.key !== 'PageUp' && event.key !== 'PageDown') {
                    return;
                }
            }

            const currentTabs = getTabSequence();
            if (currentTabs.length < 2) {
                return;
            }

            const activeIndex = currentTabs.indexOf(activeRequestId);
            if (activeIndex === -1) {
                return;
            }

            event.preventDefault();
            const direction = event.key === 'PageUp' ? -1 : 1;

            if (event.shiftKey) {
                setTabs((previous) => {
                    const nextTabs = getTabSequence(previous, activeRequestId);
                    const currentIndex = nextTabs.indexOf(activeRequestId);
                    if (currentIndex === -1) {
                        return previous;
                    }

                    const targetIndex = Math.min(Math.max(currentIndex + direction, 0), nextTabs.length - 1);
                    if (targetIndex === currentIndex) {
                        return previous;
                    }

                    const reorderedTabs = [...nextTabs];
                    const [movedTabId] = reorderedTabs.splice(currentIndex, 1);
                    reorderedTabs.splice(targetIndex, 0, movedTabId);
                    return reorderedTabs;
                });
                return;
            }

            const nextIndex = (activeIndex + direction + currentTabs.length) % currentTabs.length;
            openRequest(currentTabs[nextIndex]);
        }

        window.addEventListener('keydown', handleGlobalKeyDown, true);
        return () => window.removeEventListener('keydown', handleGlobalKeyDown, true);
    }, [activeRequestId, tabs, workspacePath]);

    function applySnapshot(snapshot, { expandedFolderPathsOverride = null } = {}) {
        if (!snapshot) {
            return;
        }

        const nextRequests = (snapshot.requests || []).map(ensureRequestShape);
        const nextFolders = snapshot.folders || [];
        const nextRequestIds = new Set(nextRequests.map((request) => request.id));
        const nextUiState = snapshot.uiState || {};
        const nextTabs = Array.isArray(nextUiState.open_request_ids)
            ? [...new Set(nextUiState.open_request_ids.filter((requestId) => nextRequestIds.has(requestId)))].slice(0, 12)
            : [];
        const preferredActiveRequestId = nextRequestIds.has(nextUiState.active_request_id) ? nextUiState.active_request_id : '';
        const nextActiveId = preferredActiveRequestId || nextTabs[0] || nextRequests[0]?.id || '';
        const nextVisibleTabs = nextActiveId && !nextTabs.includes(nextActiveId) ? [nextActiveId, ...nextTabs].slice(0, 12) : nextTabs;
        const nextExpandedFolderPaths = normalizeExpandedFolderPaths(expandedFolderPathsOverride ?? nextUiState.expanded_folder_paths, nextFolders);

        setWorkspaceId(snapshot.workspace?.id || snapshot.workspaceId || '');
        setWorkspacePath(snapshot.workspacePath);
        setWorkspaceName(snapshot.workspace?.name || snapshot.workspaceName || 'Workspace');
        setWorkspaces(snapshot.workspaces || []);
        setFolders(nextFolders);
        setRequests(nextRequests);
        setEnvironments(normalizeEnvironmentsState(snapshot.environments || EMPTY_ENVIRONMENTS));
        setTabs(nextVisibleTabs);
        setActiveRequestId(nextActiveId);
        setRequestEditorTabById(filterRequestStateMap(nextUiState.request_editor_tab_by_id, nextRequestIds));
        setResponseTabById(filterRequestStateMap(nextUiState.response_tab_by_id, nextRequestIds));
        setExpandedFolderPaths(nextExpandedFolderPaths);
        setResponses((previous) => Object.fromEntries(Object.entries(previous).filter(([requestId]) => nextRequestIds.has(requestId))));
        setTreeFilter(typeof nextUiState.tree_filter === 'string' ? nextUiState.tree_filter : '');
        setUrlFilter(typeof nextUiState.url_filter === 'string' ? nextUiState.url_filter : '');
    }

    function toggleFolderExpansion(folderPath, nextExpanded) {
        setExpandedFolderPaths((previous) => {
            const normalizedFolderPath = String(folderPath || '').trim();
            if (!normalizedFolderPath) {
                return previous;
            }

            if (nextExpanded) {
                return previous.includes(normalizedFolderPath) ? previous : [...previous, normalizedFolderPath];
            }

            return previous.filter((path) => path !== normalizedFolderPath);
        });
    }

    async function openManagedWorkspace(workspaceId) {
        setIsBusy(true);
        setStatus('Opening workspace...');
        try {
            const snapshot = await requiiIpc.openWorkspace(workspaceId);
            applySnapshot(snapshot);
            setIsWorkspaceReady(true);
            setStatus(`Opened workspace ${snapshot.workspace?.name || snapshot.workspaceName || 'Workspace'}.`);
        } catch (error) {
            setStatus(error.message || 'Failed to open workspace.');
        } finally {
            setIsBusy(false);
        }
    }

    async function openWorkspaceFolder(targetWorkspacePath = workspacePath, targetWorkspaceName = workspaceName || 'Workspace') {
        if (!targetWorkspacePath) {
            return;
        }

        setStatus(`Opening ${targetWorkspaceName} folder...`);
        try {
            await requiiIpc.openWorkspaceFolder(targetWorkspacePath);
            setStatus(`Opened folder for ${targetWorkspaceName}.`);
        } catch (error) {
            setStatus(error.message || `Failed to open the folder for ${targetWorkspaceName}.`);
        }
    }

    async function importManagedWorkspace(source = 'requii') {
        const isInsomniaImport = source === 'insomnia';
        setIsBusy(true);
        setStatus(isInsomniaImport ? 'Importing Insomnia workspace...' : 'Importing workspace...');
        try {
            const snapshot = await requiiIpc.importWorkspace(source);
            if (!snapshot) {
                setStatus(isInsomniaImport ? 'Insomnia import cancelled.' : 'Workspace import cancelled.');
                return;
            }

            applySnapshot(snapshot);
            setIsWorkspaceReady(true);
            setStatus(`${isInsomniaImport ? 'Imported Insomnia workspace' : 'Imported workspace'} ${snapshot.workspace?.name || snapshot.workspaceName || 'Workspace'}.`);
        } catch (error) {
            setStatus(error.message || (isInsomniaImport ? 'Failed to import Insomnia workspace.' : 'Failed to import workspace.'));
        } finally {
            setIsBusy(false);
        }
    }

    async function deleteManagedWorkspace(workspace) {
        if (!workspace) {
            return;
        }

        const confirmed = window.confirm(`Delete this workspace?\n\n${workspace.name}\n\nAll requests, folders, and environments in it will be permanently removed.`);
        if (!confirmed) {
            return;
        }

        setIsBusy(true);
        setStatus(`Deleting workspace ${workspace.name}...`);
        try {
            const snapshot = await requiiIpc.deleteWorkspace(workspace.id);
            applySnapshot(snapshot);
            setIsWorkspaceReady(true);
            setStatus(`Deleted workspace ${workspace.name}.`);
        } catch (error) {
            setStatus(error.message || `Failed to delete workspace ${workspace.name}.`);
        } finally {
            setIsBusy(false);
        }
    }

    function startEditingWorkspace(workspace) {
        if (!workspace) {
            return;
        }

        setEditingWorkspaceId(workspace.id);
        setDraftWorkspaceName(workspace.name || '');
    }

    function cancelWorkspaceEditing() {
        setEditingWorkspaceId(null);
        setDraftWorkspaceName('');
    }

    async function saveWorkspaceName(workspaceId) {
        const trimmedName = draftWorkspaceName.trim();
        const targetWorkspace = workspaces.find((workspace) => workspace.id === workspaceId);

        if (!trimmedName) {
            cancelWorkspaceEditing();
            return;
        }

        if (!targetWorkspace || trimmedName === targetWorkspace.name) {
            cancelWorkspaceEditing();
            return;
        }

        setIsBusy(true);
        setStatus(`Renaming workspace ${targetWorkspace.name}...`);
        try {
            const snapshot = await requiiIpc.renameWorkspace(workspaceId, trimmedName);
            applySnapshot(snapshot);
            setStatus(`Renamed workspace to ${trimmedName}.`);
        } catch (error) {
            setStatus(error.message || `Failed to rename workspace ${targetWorkspace.name}.`);
        } finally {
            cancelWorkspaceEditing();
            setIsBusy(false);
        }
    }

    function openRequest(requestId) {
        const request = requests.find((item) => item.id === requestId);
        if (request) {
            queueTreeReveal({ type: 'request', requestId, folderPath: request.path || '' });
            ensureTreePathExpanded(request.path || '');
        }

        setActiveRequestId(requestId);
        setTabs((previous) => {
            const nextTabs = activeRequestId && !previous.includes(activeRequestId) ? [activeRequestId, ...previous].slice(0, 12) : previous;
            return nextTabs.includes(requestId) ? nextTabs : [...nextTabs, requestId].slice(-12);
        });
        setRequestEditorTabById((previous) => ({ ...previous, [requestId]: previous[requestId] || 'query' }));
        setResponseTabById((previous) => ({ ...previous, [requestId]: previous[requestId] || 'body' }));
    }

    function closeTab(requestId) {
        const closingIndex = tabs.indexOf(requestId);
        const remaining = tabs.filter((tabId) => tabId !== requestId);
        setTabs(remaining);
        if (activeRequestId === requestId) {
            if (closingIndex === -1) {
                setActiveRequestId('');
                return;
            }

            setActiveRequestId(remaining[Math.min(closingIndex, remaining.length - 1)] || '');
        }
    }

    function startTabDrag(requestId) {
        setDraggedTabId(requestId);
    }

    function clearTabDrag() {
        setDraggedTabId(null);
    }

    function reorderTabs(draggedId, targetId, position) {
        if (!draggedId || !targetId || draggedId === targetId) {
            return;
        }

        setTabs((previous) => {
            const sourceIndex = previous.indexOf(draggedId);
            const targetIndex = previous.indexOf(targetId);
            if (sourceIndex === -1 || targetIndex === -1) {
                return previous;
            }

            const nextTabs = [...previous];
            const [draggedIdValue] = nextTabs.splice(sourceIndex, 1);
            const adjustedTargetIndex = sourceIndex < targetIndex ? targetIndex - 1 : targetIndex;
            const insertIndex = position === 'after' ? adjustedTargetIndex + 1 : adjustedTargetIndex;

            nextTabs.splice(insertIndex, 0, draggedIdValue);

            if (nextTabs.every((tabId, index) => tabId === previous[index])) {
                return previous;
            }

            return nextTabs;
        });
    }

    function renameEnvironmentVariableUsages(oldKey, newKey) {
        if (!oldKey || !newKey || oldKey === newKey) {
            return;
        }

        const nextRequests = requests.map((request) => renameEnvironmentVariableReferencesInRequest(request, oldKey, newKey));
        const changedRequests = nextRequests.filter((request, index) => request !== requests[index]);

        if (changedRequests.length > 0) {
            setRequests(nextRequests);
            changedRequests.forEach((request) => scheduleSave(request));
        }

        updateEnvironments((previous) => renameEnvironmentVariableReferencesInEnvironments(previous, oldKey, newKey));
    }

    async function fetchOAuth2Token(requestId, oauth2Config) {
        if (!activeEnvironment) {
            setStatus('No active environment is selected for OAuth2 token fetching.');
            return;
        }

        setIsBusy(true);
        setStatus('Fetching OAuth2 token...');
        try {
            const tokenResult = await requiiIpc.fetchOAuth2Token(oauth2Config, requestExecutionEnvironment);
            setRequests((previous) =>
                previous.map((request) => {
                    if (request.id !== requestId) {
                        return request;
                    }

                    const nextRequest = {
                        ...request,
                        auth: {
                            ...request.auth,
                            type: 'oauth2',
                            oauth2: {
                                ...(request.auth?.oauth2 || {}),
                                ...oauth2Config,
                                accessToken: tokenResult.accessToken,
                                tokenPrefix: tokenResult.tokenType || oauth2Config.tokenPrefix || 'Bearer',
                            },
                        },
                    };

                    scheduleSave(nextRequest);
                    return nextRequest;
                }),
            );
            setStatus('Fetched OAuth2 token successfully.');
        } catch (error) {
            setStatus(error.message || 'Failed to fetch OAuth2 token.');
        } finally {
            setIsBusy(false);
        }
    }

    function scheduleSave(request) {
        if (!workspacePath) {
            return;
        }

        const existingTimer = requestSaveTimers.current.get(request.id);
        if (existingTimer) {
            window.clearTimeout(existingTimer);
        }

        const nextSaveVersion = (requestSaveVersionsRef.current.get(request.id) || 0) + 1;
        requestSaveVersionsRef.current.set(request.id, nextSaveVersion);

        const timer = window.setTimeout(async () => {
            try {
                const savedRequest = await requiiIpc.saveRequest(workspacePath, request);
                if (requestSaveVersionsRef.current.get(savedRequest.id) !== nextSaveVersion) {
                    return;
                }

                setRequests((previous) => previous.map((item) => (item.id === savedRequest.id ? ensureRequestShape(savedRequest) : item)));
                setStatus(`Saved ${savedRequest.name}.`);
            } catch (error) {
                if (requestSaveVersionsRef.current.get(request.id) !== nextSaveVersion) {
                    return;
                }

                setStatus(error.message || `Failed to save ${request.name}.`);
            }
        }, 350);

        requestSaveTimers.current.set(request.id, timer);
    }

    function scheduleEnvironmentSave(nextEnvironments) {
        if (!workspacePath) {
            return;
        }

        if (environmentsSaveTimer.current) {
            window.clearTimeout(environmentsSaveTimer.current);
            environmentsSaveTimer.current = null;
        }

        void (async () => {
            try {
                await requiiIpc.saveEnvironments(workspacePath, nextEnvironments);
                setStatus('Saved environments.json.');
            } catch (error) {
                setStatus(error.message || 'Failed to save environments.');
            }
        })();
    }

    function updateRequest(requestId, updater) {
        setRequests((previous) =>
            previous.map((request) => {
                if (request.id !== requestId) {
                    return request;
                }

                const updated = ensureRequestShape(typeof updater === 'function' ? updater(request) : updater);
                scheduleSave(updated);
                return updated;
            }),
        );
    }

    function updateEnvironments(updater) {
        setEnvironments((previous) => {
            const next = normalizeEnvironmentsState(typeof updater === 'function' ? updater(previous) : updater);
            scheduleEnvironmentSave(next);
            return next;
        });
    }

    function renameRequestFromTree(requestId, updater) {
        const currentRequest = requests.find((request) => request.id === requestId);
        if (!currentRequest) {
            return;
        }

        const updatedRequest = ensureRequestShape(typeof updater === 'function' ? updater(currentRequest) : updater);
        if (JSON.stringify(updatedRequest) === JSON.stringify(currentRequest)) {
            return;
        }

        const beforeSnapshot = createFileStructureSnapshot();
        const nextRequests = requests.map((request) => (request.id === requestId ? updatedRequest : request));
        const afterSnapshot = buildFileStructureSnapshot(nextRequests, folders);

        setRequests(nextRequests);
        scheduleSave(updatedRequest);
        pushFileStructureHistory(beforeSnapshot, afterSnapshot);
        if (updatedRequest.name !== currentRequest.name) {
            setStatus(`Renamed request to ${updatedRequest.name}.`);
        }
    }

    function openComposer(type, parentPath = '', suggestedName = '') {
        if (type !== 'workspace' && !workspacePath) {
            return;
        }

        setComposer({
            open: true,
            type,
            parentPath,
            name: suggestedName || (type === 'request' ? 'Untitled Request' : type === 'workspace' ? 'New Workspace' : 'New Folder'),
        });
    }

    function closeComposer() {
        setComposer(emptyComposer());
    }

    async function submitComposer() {
        const name = composer.name.trim();
        if (!name || (composer.type !== 'workspace' && !workspacePath)) {
            return;
        }

        setIsBusy(true);
        try {
            if (composer.type === 'workspace') {
                setStatus(`Creating workspace ${name}...`);
                const snapshot = await requiiIpc.createWorkspace(name);
                applySnapshot(snapshot);
                setIsWorkspaceReady(true);
                setStatus(`Created workspace ${snapshot.workspace?.name || name}.`);
            } else if (composer.type === 'folder') {
                const beforeSnapshot = createFileStructureSnapshot();
                setStatus(`Creating folder ${name}...`);
                const snapshot = await requiiIpc.createFolder(workspacePath, composer.parentPath, name);
                const nextExpandedFolderPaths = [...new Set([...expandedFolderPaths, ...getFolderAncestors(composer.parentPath || '')])];
                queueTreeReveal({ type: 'folder', folderPath: composer.parentPath ? `${composer.parentPath}/${name}` : name });
                applySnapshot(snapshot, { expandedFolderPathsOverride: nextExpandedFolderPaths });
                pushFileStructureHistory(beforeSnapshot, buildFileStructureSnapshot(snapshot.requests || [], snapshot.folders || [], { expandedFolderPaths: nextExpandedFolderPaths }));
                setStatus(`Created folder ${name}.`);
            } else {
                const beforeSnapshot = createFileStructureSnapshot();
                setStatus(`Creating request ${name}...`);
                const request = ensureRequestShape(await requiiIpc.createRequest(workspacePath, composer.parentPath, name));
                const nextRequests = [...requests, request];
                const nextExpandedFolderPaths = [...new Set([...expandedFolderPaths, ...getFolderAncestors(request.path || composer.parentPath || '')])];
                const nextTabState = buildRequestTabState(request.id);
                setRequests(nextRequests);
                queueTreeReveal({ type: 'request', requestId: request.id, folderPath: request.path || composer.parentPath || '' });
                openRequest(request.id);
                if (!folders.includes(composer.parentPath) && composer.parentPath) {
                    setFolders((previous) => [...previous, composer.parentPath]);
                }
                pushFileStructureHistory(beforeSnapshot, buildFileStructureSnapshot(nextRequests, folders, { expandedFolderPaths: nextExpandedFolderPaths, ...nextTabState }));
                setStatus(`Created request ${request.name}.`);
            }
            closeComposer();
        } catch (error) {
            setStatus(error.message || `Failed to create ${composer.type}.`);
        } finally {
            setIsBusy(false);
        }
    }

    async function deleteFolder(folderPath) {
        if (!workspacePath || !folderPath) {
            return;
        }

        const confirmed = window.confirm(`Delete this folder and everything inside it?\n\n${folderPath}\n\nAll nested folders and requests will be permanently removed.`);
        if (!confirmed) {
            return;
        }

        setIsBusy(true);
        try {
            const beforeSnapshot = createFileStructureSnapshot();
            const snapshot = await requiiIpc.deleteFolder(workspacePath, folderPath);
            const nextExpandedFolderPaths = pruneExpandedFolderPaths(expandedFolderPaths, folderPath);
            const nextTabState = buildFilteredRequestTabState((snapshot.requests || []).map(ensureRequestShape));
            applySnapshot(snapshot, { expandedFolderPathsOverride: nextExpandedFolderPaths });
            pushFileStructureHistory(beforeSnapshot, buildFileStructureSnapshot(snapshot.requests || [], snapshot.folders || [], { expandedFolderPaths: nextExpandedFolderPaths, ...nextTabState }));
            setStatus(`Deleted folder ${folderPath}.`);
        } catch (error) {
            setStatus(error.message || `Failed to delete ${folderPath}.`);
        } finally {
            setIsBusy(false);
        }
    }

    async function renameFolder(folderPath, nextName) {
        if (!workspacePath || !folderPath) {
            return false;
        }

        const trimmedName = nextName.trim();
        if (!trimmedName) {
            return false;
        }

        setIsBusy(true);
        setStatus(`Renaming folder ${folderNameFromPath(folderPath)}...`);
        try {
            const beforeSnapshot = createFileStructureSnapshot();
            const snapshot = await requiiIpc.renameFolder(workspacePath, folderPath, trimmedName);
            const parentPath = folderPath.includes('/') ? folderPath.slice(0, folderPath.lastIndexOf('/')) : '';
            const renamedFolderPath = parentPath ? `${parentPath}/${trimmedName}` : trimmedName;
            const nextExpandedFolderPaths = remapExpandedFolderPaths(expandedFolderPaths, folderPath, renamedFolderPath);
            applySnapshot(snapshot, { expandedFolderPathsOverride: nextExpandedFolderPaths });
            pushFileStructureHistory(beforeSnapshot, buildFileStructureSnapshot(snapshot.requests || [], snapshot.folders || [], { expandedFolderPaths: nextExpandedFolderPaths }));
            setStatus(`Renamed folder to ${trimmedName}.`);
            return true;
        } catch (error) {
            setStatus(error.message || `Failed to rename ${folderNameFromPath(folderPath)}.`);
            return false;
        } finally {
            setIsBusy(false);
        }
    }

    async function deleteRequest(request) {
        if (!workspacePath || !request) {
            return;
        }

        const confirmed = window.confirm(`Delete this request?\n\n${request.name}\n\nThis will permanently remove the request file from the workspace.`);
        if (!confirmed) {
            return;
        }

        setIsBusy(true);
        try {
            const beforeSnapshot = createFileStructureSnapshot();
            const snapshot = await requiiIpc.deleteRequest(workspacePath, request);
            applySnapshot(snapshot);
            setTabs((previous) => previous.filter((tabId) => tabId !== request.id));
            pushFileStructureHistory(beforeSnapshot, buildFileStructureSnapshot(snapshot.requests || [], snapshot.folders || [], buildFilteredRequestTabState((snapshot.requests || []).map(ensureRequestShape), tabs.filter((tabId) => tabId !== request.id), activeRequestId === request.id ? '' : activeRequestId)));
            setStatus(`Deleted request ${request.name}.`);
        } catch (error) {
            setStatus(error.message || `Failed to delete ${request.name}.`);
        } finally {
            setIsBusy(false);
        }
    }

    async function duplicateRequest(request, requestFolderPath = '') {
        if (!workspacePath || !request) {
            return;
        }

        const requestName = String(request.name || 'Untitled Request').trim() || 'Untitled Request';
        const duplicatedRequest = ensureRequestShape({
            ...JSON.parse(JSON.stringify(request)),
            id: '',
            name: `Copy of ${requestName}`,
            filePath: '',
            path: request.path || requestFolderPath || '',
            order: Date.now(),
        });

        setIsBusy(true);
        try {
            const beforeSnapshot = createFileStructureSnapshot();
            const savedRequest = ensureRequestShape(await requiiIpc.saveRequest(workspacePath, duplicatedRequest));
            const targetFolderPath = savedRequest.path || request.path || requestFolderPath || '';
            const { nextRequests, changedRequests } = reorderRequestsCollection(
                [...requests, savedRequest],
                savedRequest.id,
                {
                    folderPath: targetFolderPath,
                    requestId: request.id,
                    position: 'after',
                },
            );

            setRequests(nextRequests);
            changedRequests.forEach((changedRequest) => scheduleSave(changedRequest));
            queueTreeReveal({ type: 'request', requestId: savedRequest.id, folderPath: targetFolderPath });
            openRequest(savedRequest.id);
            pushFileStructureHistory(beforeSnapshot, buildFileStructureSnapshot(nextRequests, folders, { expandedFolderPaths: [...new Set([...expandedFolderPaths, ...getFolderAncestors(targetFolderPath)])], ...buildRequestTabState(savedRequest.id) }));
            setStatus(`Duplicated request as ${savedRequest.name}.`);
        } catch (error) {
            setStatus(error.message || `Failed to duplicate ${requestName}.`);
        } finally {
            setIsBusy(false);
        }
    }

    function beautifyRequestBody() {
        if (!activeRequest || activeRequest.body.type !== 'json') {
            return;
        }

        const content = activeRequest.body.content?.trim();
        if (!content) {
            updateRequest(activeRequest.id, (current) => ({
                ...current,
                body: {
                    ...current.body,
                    content: '{\n\n}',
                },
            }));
            setStatus('Initialized empty JSON body.');
            return;
        }

        try {
            const formatted = JSON.stringify(JSON.parse(content), null, 2);
            updateRequest(activeRequest.id, (current) => ({
                ...current,
                body: {
                    ...current.body,
                    content: formatted,
                },
            }));
            setStatus('Beautified request JSON body.');
        } catch {
            setStatus('Body is not valid JSON.');
        }
    }

    async function runRequest() {
        if (!activeRequest) {
            return;
        }

        const requestId = activeRequest.id;
        const requestName = activeRequest.name;
        setIsBusy(true);
        setStatus(`Executing ${requestName}...`);
        try {
            const response = await requiiIpc.executeRequest(activeRequest, requestExecutionEnvironment);
            setResponses((previous) => ({ ...previous, [requestId]: response }));
            setResponseTabById((previous) => ({ ...previous, [requestId]: 'body' }));
            scrollSectionIntoView(responseSectionRef.current);
            if (response.hasResponse) {
                setStatus(`Received ${response.status} ${response.statusText} in ${response.durationMs} ms.`);
            } else {
                setStatus(response.error?.title || `Failed to execute ${requestName}.`);
            }
        } catch (error) {
            setResponses((previous) => ({
                ...previous,
                [requestId]: {
                    ok: false,
                    hasResponse: false,
                    status: 'ERROR',
                    statusText: 'Request failed unexpectedly',
                    headers: {},
                    data: error.message || 'Unknown error',
                    durationMs: 0,
                    requestPreview: null,
                    error: {
                        stage: 'request-setup',
                        title: 'Request failed unexpectedly',
                        summary: 'The renderer could not complete the request flow.',
                        detail: error.message || 'Unknown error',
                        suggestion: 'Check the request configuration and try again.',
                        code: '',
                    },
                },
            }));
            setResponseTabById((previous) => ({ ...previous, [requestId]: 'body' }));
            scrollSectionIntoView(responseSectionRef.current);
            setStatus(error.message || `Failed to execute ${requestName}.`);
        } finally {
            setIsBusy(false);
        }
    }

    async function importPayload() {
        if (!workspacePath) {
            return;
        }

        setIsBusy(true);
        setStatus('Importing payload...');
        try {
            const snapshot = await requiiIpc.importPayload(workspacePath);
            if (!snapshot) {
                setStatus('Import cancelled.');
                return;
            }
            applySnapshot(snapshot);
            setStatus('Import complete.');
        } catch (error) {
            setStatus(error.message || 'Import failed.');
        } finally {
            setIsBusy(false);
        }
    }

    async function openWorkspaceExportDialog(targetWorkspacePath = workspacePath, targetWorkspaceName = workspaceName || 'Workspace') {
        if (!targetWorkspacePath) {
            return;
        }

        setIsBusy(true);
        setStatus(`Preparing export for ${targetWorkspaceName}...`);

        try {
            const snapshot = targetWorkspacePath === workspacePath
                ? {
                    workspacePath: targetWorkspacePath,
                    workspaceName: targetWorkspaceName,
                    folders,
                    requests,
                }
                : await requiiIpc.loadWorkspace(targetWorkspacePath);

            setWorkspaceExportDialog({
                workspacePath: targetWorkspacePath,
                workspaceName: snapshot.workspace?.name || snapshot.workspaceName || targetWorkspaceName,
                folders: snapshot.folders || [],
                requests: (snapshot.requests || []).map(ensureRequestShape),
            });
            setStatus(`Choose what to export from ${snapshot.workspace?.name || snapshot.workspaceName || targetWorkspaceName}.`);
        } catch (error) {
            setStatus(error.message || `Failed to prepare export for ${targetWorkspaceName}.`);
        } finally {
            setIsBusy(false);
        }
    }

    async function exportWorkspace(selection) {
        if (!workspaceExportDialog?.workspacePath) {
            return;
        }

        setIsBusy(true);
        setStatus(`Exporting ${workspaceExportDialog.workspaceName}...`);

        try {
            const target = await requiiIpc.exportWorkspace(workspaceExportDialog.workspacePath, selection);
            setStatus(target ? `${workspaceExportDialog.workspaceName} export written to ${target}.` : `${workspaceExportDialog.workspaceName} export cancelled.`);
        } catch (error) {
            setStatus(error.message || `Failed to export ${workspaceExportDialog.workspaceName}.`);
        } finally {
            setWorkspaceExportDialog(null);
            setIsBusy(false);
        }
    }

    async function exportActiveRequest() {
        if (!workspacePath || !activeRequest) {
            return;
        }

        setStatus(`Exporting ${activeRequest.name}...`);
        const target = await requiiIpc.exportRequest(workspacePath, activeRequest);
        setStatus(target ? `Request export written to ${target}.` : 'Request export cancelled.');
    }

    async function copyActiveRequestAsCurl() {
        if (!activeRequest) {
            return;
        }

        setCurlViewer({
            title: `cURL Command • ${activeRequest.name}`,
            request: activeRequest,
            activeEnvironment: requestExecutionEnvironment,
        });
        setStatus(`Opened cURL command viewer for ${activeRequest.name}.`);
    }

    function addEnvironment() {
        const id = `env_${Date.now()}`;
        updateEnvironments((previous) => ({
            ...previous,
            active_environment_id: id,
            environments: [...previous.environments, { id, name: 'New Environment', variables: {} }],
        }));
    }

    function startPaneResize(side) {
        resizeState.current = { side };
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
    }

    function startRequestDrag(event, requestId, previewElement) {
        event.preventDefault();
        event.stopPropagation();
        if (!previewElement || folderDragState) {
            return;
        }

        const rect = previewElement.getBoundingClientRect();
        setRequestDragState({
            requestId,
            x: event.clientX,
            y: event.clientY,
            offsetX: event.clientX - rect.left,
            offsetY: event.clientY - rect.top,
            width: rect.width,
        });
        setRequestDropTarget(null);
        updateTreeAutoScrollPointer(event.clientY);
        document.body.style.userSelect = 'none';
        document.body.style.cursor = 'grabbing';
    }

    function clearRequestDrag() {
        setRequestDragState(null);
        setRequestDropTarget(null);
        stopTreeAutoScroll();
        document.body.style.userSelect = '';
        document.body.style.cursor = '';
    }

    function startFolderDrag(event, folderPath, previewElement) {
        event.preventDefault();
        event.stopPropagation();
        if (!previewElement || requestDragState) {
            return;
        }

        const rect = previewElement.getBoundingClientRect();
        setFolderDragState({
            folderPath,
            x: event.clientX,
            y: event.clientY,
            offsetX: event.clientX - rect.left,
            offsetY: event.clientY - rect.top,
            width: rect.width,
        });
        setFolderDropTarget(null);
        updateTreeAutoScrollPointer(event.clientY);
        document.body.style.userSelect = 'none';
        document.body.style.cursor = 'grabbing';
    }

    function clearFolderDrag() {
        setFolderDragState(null);
        setFolderDropTarget(null);
        stopTreeAutoScroll();
        document.body.style.userSelect = '';
        document.body.style.cursor = '';
    }

    async function commitFolderDrop(target) {
        if (!workspacePath || !draggedFolderPath || !target) {
            clearFolderDrag();
            return;
        }

        const sourcePath = draggedFolderPath;
        clearFolderDrag();
        setIsBusy(true);
        setStatus(`Moving folder ${folderNameFromPath(sourcePath)}...`);

        try {
            const beforeSnapshot = createFileStructureSnapshot();
            const snapshot = await requiiIpc.moveFolder(workspacePath, sourcePath, target.folderPath || '', target.insertIndex ?? null);
            const movedFolderPath = target.folderPath ? `${target.folderPath}/${folderNameFromPath(sourcePath)}` : folderNameFromPath(sourcePath);
            const nextExpandedFolderPaths = remapExpandedFolderPaths(expandedFolderPaths, sourcePath, movedFolderPath);
            applySnapshot(snapshot, { expandedFolderPathsOverride: nextExpandedFolderPaths });
            pushFileStructureHistory(beforeSnapshot, buildFileStructureSnapshot(snapshot.requests || [], snapshot.folders || [], { expandedFolderPaths: nextExpandedFolderPaths }));
            setStatus(`Moved folder ${folderNameFromPath(sourcePath)}.`);
        } catch (error) {
            setStatus(error.message || `Failed to move ${folderNameFromPath(sourcePath)}.`);
        } finally {
            setIsBusy(false);
        }
    }

    function commitRequestDrop(target) {
        if (!draggedRequestId || !target) {
            return;
        }

        const beforeSnapshot = createFileStructureSnapshot();
        const { nextRequests, changedRequests } = reorderRequestsCollection(requests, draggedRequestId, target);
        if (changedRequests.length === 0) {
            return;
        }

        setRequests(nextRequests);
        changedRequests.forEach(scheduleSave);
        pushFileStructureHistory(beforeSnapshot, buildFileStructureSnapshot(nextRequests, folders));
    }

    function handleRequestDropOnFolder(event, folderPath = '') {
        event.preventDefault();
        event.stopPropagation();
        if (!draggedRequestId) {
            return;
        }

        const beforeSnapshot = createFileStructureSnapshot();
        const { nextRequests, changedRequests } = reorderRequestsCollection(requests, draggedRequestId, {
            folderPath,
            position: 'after',
        });
        if (changedRequests.length > 0) {
            setRequests(nextRequests);
            changedRequests.forEach(scheduleSave);
            pushFileStructureHistory(beforeSnapshot, buildFileStructureSnapshot(nextRequests, folders));
        }
        clearRequestDrag();
    }

    function handleRequestDropOnGap(event, folderPath = '', insertIndex = 0) {
        event.preventDefault();
        event.stopPropagation();
        if (!draggedRequestId) {
            return;
        }

        const beforeSnapshot = createFileStructureSnapshot();
        const { nextRequests, changedRequests } = reorderRequestsCollection(requests, draggedRequestId, {
            folderPath,
            insertIndex,
        });
        if (changedRequests.length > 0) {
            setRequests(nextRequests);
            changedRequests.forEach(scheduleSave);
            pushFileStructureHistory(beforeSnapshot, buildFileStructureSnapshot(nextRequests, folders));
        }
        clearRequestDrag();
    }

    function handleRequestDropOnRequest(event, targetRequestId, position) {
        event.preventDefault();
        event.stopPropagation();
        if (!draggedRequestId || draggedRequestId === targetRequestId) {
            clearRequestDrag();
            return;
        }

        const targetRequest = requests.find((request) => request.id === targetRequestId);
        if (!targetRequest) {
            clearRequestDrag();
            return;
        }

        const beforeSnapshot = createFileStructureSnapshot();
        const { nextRequests, changedRequests } = reorderRequestsCollection(requests, draggedRequestId, {
            folderPath: targetRequest.path || '',
            requestId: targetRequestId,
            position,
        });
        if (changedRequests.length > 0) {
            setRequests(nextRequests);
            changedRequests.forEach(scheduleSave);
            pushFileStructureHistory(beforeSnapshot, buildFileStructureSnapshot(nextRequests, folders));
        }
        clearRequestDrag();
    }

    function handleRequestDragOverFolder(event, folderPath = '') {
        if (!draggedRequestId) {
            return;
        }

        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = 'move';
        setRequestDropTarget({ type: 'folder', folderPath });
    }

    function handleRequestDragOverRequest(event, requestId) {
        if (!draggedRequestId || draggedRequestId === requestId) {
            return;
        }

        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = 'move';
        const bounds = event.currentTarget.getBoundingClientRect();
        const midpoint = bounds.top + bounds.height / 2;
        const position = event.clientY < midpoint ? 'before' : 'after';
        setRequestDropTarget({ type: 'request', requestId, position });
    }

    function handleRequestDragOverGap(event, folderPath = '', insertIndex = 0) {
        if (!draggedRequestId) {
            return;
        }

        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = 'move';
        setRequestDropTarget({ type: 'gap', folderPath, insertIndex });
    }

    useEffect(() => {
        if (!requestDragState) {
            return;
        }

        function updateDropTarget(clientX, clientY) {
            const target = document.elementFromPoint(clientX, clientY)?.closest('[data-request-drop-type]');
            if (!target) {
                setRequestDropTarget(null);
                return;
            }

            const type = target.getAttribute('data-request-drop-type');
            if (type === 'folder') {
                setRequestDropTarget({ type: 'folder', folderPath: target.getAttribute('data-folder-path') || '' });
                return;
            }

            if (type === 'gap') {
                setRequestDropTarget({
                    type: 'gap',
                    folderPath: target.getAttribute('data-folder-path') || '',
                    insertIndex: Number(target.getAttribute('data-insert-index') || 0),
                });
                return;
            }

            setRequestDropTarget(null);
        }

        function handleMouseMove(event) {
            setRequestDragState((previous) => (previous ? { ...previous, x: event.clientX, y: event.clientY } : previous));
            updateTreeAutoScrollPointer(event.clientY);
            updateDropTarget(event.clientX, event.clientY);
        }

        function handleMouseUp(event) {
            updateDropTarget(event.clientX, event.clientY);
            const target = requestDropTargetRef.current;
            if (target) {
                if (target.type === 'folder') {
                    commitRequestDrop({ folderPath: target.folderPath || '', position: 'after' });
                }

                if (target.type === 'gap') {
                    commitRequestDrop({ folderPath: target.folderPath || '', insertIndex: target.insertIndex });
                }
            }
            clearRequestDrag();
        }

        window.addEventListener('mousemove', handleMouseMove);
        window.addEventListener('mouseup', handleMouseUp, { once: true });

        return () => {
            window.removeEventListener('mousemove', handleMouseMove);
            window.removeEventListener('mouseup', handleMouseUp);
        };
    }, [requestDragState, draggedRequestId]);

    useEffect(() => {
        if (!requestDragState && !folderDragState) {
            stopTreeAutoScroll();
            return undefined;
        }

        function step() {
            const container = treeScrollRef.current;
            const pointerY = dragAutoScrollRef.current.pointerY;

            if (!container || !pointerY) {
                dragAutoScrollRef.current.rafId = window.requestAnimationFrame(step);
                return;
            }

            const bounds = container.getBoundingClientRect();
            const threshold = 56;
            let delta = 0;

            if (pointerY < bounds.top + threshold) {
                delta = -Math.ceil(((bounds.top + threshold - pointerY) / threshold) * 18);
            } else if (pointerY > bounds.bottom - threshold) {
                delta = Math.ceil(((pointerY - (bounds.bottom - threshold)) / threshold) * 18);
            }

            if (delta !== 0) {
                container.scrollTop += delta;
            }

            dragAutoScrollRef.current.rafId = window.requestAnimationFrame(step);
        }

        dragAutoScrollRef.current.rafId = window.requestAnimationFrame(step);

        return () => stopTreeAutoScroll();
    }, [requestDragState, folderDragState]);

    useEffect(() => {
        if (!requestDragState && !folderDragState) {
            return undefined;
        }

        function handleEscapeKey(event) {
            if (event.key !== 'Escape') {
                return;
            }

            event.preventDefault();
            event.stopPropagation();

            if (requestDragState) {
                clearRequestDrag();
            }

            if (folderDragState) {
                clearFolderDrag();
            }
        }

        window.addEventListener('keydown', handleEscapeKey, true);
        return () => window.removeEventListener('keydown', handleEscapeKey, true);
    }, [requestDragState, folderDragState]);

    useEffect(() => {
        if (!folderDragState) {
            return;
        }

        function isInvalidFolderTarget(folderPath) {
            return Boolean(folderPath) && (folderPath === draggedFolderPath || folderPath.startsWith(`${draggedFolderPath}/`));
        }

        function updateDropTarget(clientX, clientY) {
            const target = document.elementFromPoint(clientX, clientY)?.closest('[data-folder-drop-type]');
            if (!target) {
                setFolderDropTarget(null);
                return;
            }

            const type = target.getAttribute('data-folder-drop-type');
            const folderPath = target.getAttribute('data-folder-path') || '';

            if (isInvalidFolderTarget(folderPath)) {
                setFolderDropTarget(null);
                return;
            }

            if (type === 'folder-via-request') {
                setFolderDropTarget({ type: 'folder', folderPath });
                return;
            }

            if (type === 'folder') {
                const parentPath = target.getAttribute('data-folder-parent-path') || '';
                const folderIndex = Number(target.getAttribute('data-folder-index') || 0);
                const thresholdElement = target.querySelector('[data-folder-drop-header]') || target;
                const bounds = thresholdElement.getBoundingClientRect();
                const topThreshold = bounds.top + bounds.height * 0.28;
                const bottomThreshold = bounds.bottom - bounds.height * 0.28;

                if (clientY <= topThreshold) {
                    setFolderDropTarget({ type: 'gap', folderPath: parentPath, insertIndex: folderIndex });
                    return;
                }

                if (clientY >= bottomThreshold) {
                    setFolderDropTarget({ type: 'gap', folderPath: parentPath, insertIndex: folderIndex + 1 });
                    return;
                }

                setFolderDropTarget({ type: 'folder', folderPath });
                return;
            }

            if (type === 'gap') {
                setFolderDropTarget({
                    type: 'gap',
                    folderPath,
                    insertIndex: Number(target.getAttribute('data-insert-index') || 0),
                });
                return;
            }

            setFolderDropTarget(null);
        }

        function handleMouseMove(event) {
            setFolderDragState((previous) => (previous ? { ...previous, x: event.clientX, y: event.clientY } : previous));
            updateTreeAutoScrollPointer(event.clientY);
            updateDropTarget(event.clientX, event.clientY);
        }

        function handleMouseUp(event) {
            updateDropTarget(event.clientX, event.clientY);
            const target = folderDropTargetRef.current;
            if (target) {
                if (target.type === 'folder') {
                    commitFolderDrop({ folderPath: target.folderPath || '' });
                    return;
                }

                if (target.type === 'gap') {
                    commitFolderDrop({ folderPath: target.folderPath || '', insertIndex: target.insertIndex });
                    return;
                }
            }
            clearFolderDrag();
        }

        window.addEventListener('mousemove', handleMouseMove);
        window.addEventListener('mouseup', handleMouseUp, { once: true });

        return () => {
            window.removeEventListener('mousemove', handleMouseMove);
            window.removeEventListener('mouseup', handleMouseUp);
        };
    }, [folderDragState, draggedFolderPath, workspacePath]);

    return (
        <div className="flex h-screen flex-col overflow-hidden bg-[#a9997f] text-ink">
            <header className="app-drag-region flex h-11 items-center justify-between border-b border-black/10 bg-[#8f7b60] px-3 text-ink">
                <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                        <p className="truncate text-sm font-bold tracking-[0.08em]">Requii</p>
                    </div>
                    <p className="truncate text-[11px] text-ink/60">Workspace: {workspaceName || 'Workspace'}</p>
                </div>
                <div className="app-no-drag flex items-center gap-1.5">
                    <button className="icon-action-button h-7 w-7 border-transparent bg-transparent text-ink/70 hover:bg-black/[0.08]" onClick={() => void requiiIpc.minimizeWindow()} title="Minimize window" type="button">
                        <MinimizeIcon />
                    </button>
                    <button className="icon-action-button h-7 w-7 border-transparent bg-transparent text-ink/70 hover:bg-black/[0.08]" onClick={() => void requiiIpc.toggleMaximizeWindow()} title={windowState.isMaximized ? 'Restore window' : 'Maximize window'} type="button">
                        {windowState.isMaximized ? <RestoreIcon /> : <MaximizeIcon />}
                    </button>
                    <button className="icon-action-button h-7 w-7 border-transparent bg-transparent text-ink/70 hover:bg-[#b55a42]/20 hover:text-[#7d2514]" onClick={() => void requiiIpc.closeWindow()} title="Close window" type="button">
                        <CloseIcon />
                    </button>
                </div>
            </header>
            <div
                ref={layoutRef}
                className="grid h-full w-full flex-1 overflow-x-auto overflow-y-hidden bg-black/10"
                style={{ gridTemplateColumns: `${paneSizes.left}px ${SPLITTER_WIDTH}px minmax(0,1fr) ${SPLITTER_WIDTH}px ${paneSizes.right}px` }}
            >
                <aside
                    ref={workspaceSidebarRef}
                    className="flex min-h-0 h-full flex-col overflow-hidden bg-[#aa9678]"
                    onPointerEnter={() => {
                        isWorkspaceSidebarHoveredRef.current = true;
                    }}
                    onPointerLeave={() => {
                        isWorkspaceSidebarHoveredRef.current = false;
                    }}
                >
                    <div className="border-b border-black/8 px-4 py-3">
                        <div className="flex items-center gap-2">
                            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-ink/45">Workspaces</p>
                            <span className="rounded-full bg-black/[0.06] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-ink/50">{workspaces.length}</span>
                        </div>
                        <p className="mt-1 text-xs leading-5 text-ink/60">A workspace keeps related requests, folders, and environments together.</p>
                        <div className="mt-3 flex flex-wrap gap-2">
                            <button className="ghost-button inline-flex items-center gap-2" onClick={() => openComposer('workspace')} disabled={isBusy} type="button">
                                <NewWorkspaceIcon />
                                <span>New Workspace</span>
                            </button>
                            <ImportWorkspaceMenu onImportWorkspace={importManagedWorkspace} isBusy={isBusy} buttonClassName="ghost-button inline-flex items-center gap-2 px-2.5 py-1.5" />
                        </div>
                        <div className="mt-3">
                            <ScrollSliderList label="Browse workspaces" maxHeight={196}>
                                {workspaces.map((workspace) => {
                                    const isActiveWorkspace = workspace.path === workspacePath;
                                    const isEditingWorkspace = editingWorkspaceId === workspace.id;
                                    return (
                                        <div
                                            key={workspace.id}
                                            className={`flex cursor-pointer items-center gap-2 rounded-xl border px-3 py-2 ${isActiveWorkspace ? 'border-ink bg-[#ddcaab] text-ink' : 'border-black/10 bg-[#e3cfaf]/82 text-ink/78'}`}
                                            onClick={(event) => {
                                                if (isActiveWorkspace || isBusy || isEditingWorkspace || isNestedInteractiveElement(event.target)) {
                                                    return;
                                                }

                                                void openManagedWorkspace(workspace.id);
                                            }}
                                        >
                                            {isEditingWorkspace ? (
                                                <div className="flex min-w-0 flex-1 items-center gap-2 text-left">
                                                    <span className={`inline-block h-2.5 w-2.5 rounded-full ${isActiveWorkspace ? 'bg-[#14a44d] shadow-[0_0_0_2px_rgba(20,164,77,0.18)]' : 'bg-black/15'}`}></span>
                                                    <input
                                                        autoFocus
                                                        className="w-full rounded-lg bg-transparent text-sm font-medium outline-none"
                                                        value={draftWorkspaceName}
                                                        spellCheck={false}
                                                        onChange={(event) => setDraftWorkspaceName(event.target.value)}
                                                        onBlur={() => void saveWorkspaceName(workspace.id)}
                                                        onKeyDown={(event) => {
                                                            if (event.key === 'Enter') {
                                                                event.preventDefault();
                                                                void saveWorkspaceName(workspace.id);
                                                            }
                                                            if (event.key === 'Escape') {
                                                                event.preventDefault();
                                                                cancelWorkspaceEditing();
                                                            }
                                                        }}
                                                    />
                                                </div>
                                            ) : (
                                                <button className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => openManagedWorkspace(workspace.id)} disabled={isBusy || isActiveWorkspace} type="button">
                                                    <span className={`inline-block h-2.5 w-2.5 rounded-full ${isActiveWorkspace ? 'bg-[#14a44d] shadow-[0_0_0_2px_rgba(20,164,77,0.18)]' : 'bg-black/15'}`}></span>
                                                    <span className="truncate text-sm font-medium">{workspace.name}</span>
                                                </button>
                                            )}
                                            <button className="icon-action-button" onClick={() => startEditingWorkspace(workspace)} title="Rename workspace" disabled={isBusy || isEditingWorkspace} type="button">
                                                <PencilIcon />
                                            </button>
                                            <button className="icon-action-button" onClick={() => openWorkspaceFolder(workspace.path, workspace.name)} title="Open workspace folder" disabled={isBusy} type="button">
                                                <OpenFolderIcon />
                                            </button>
                                            <button className="icon-action-button" onClick={() => void openWorkspaceExportDialog(workspace.path, workspace.name)} title={`Export ${workspace.name}`} disabled={isBusy} type="button">
                                                <ExportIcon />
                                            </button>
                                            <button className="icon-action-button" onClick={() => deleteManagedWorkspace(workspace)} title="Delete workspace" disabled={isBusy || workspaces.length <= 1} type="button">
                                                <TrashIcon />
                                            </button>
                                        </div>
                                    );
                                })}
                            </ScrollSliderList>
                        </div>
                    </div>

                    <div className="relative z-10 border-b border-black/8 px-4 py-3">
                        <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-ink/45">Filter</label>
                        <div className="relative z-10 mb-2">
                            <span className="pointer-events-none absolute left-3 top-1/2 z-10 -translate-y-1/2 text-ink/35">
                                <LinkIcon />
                            </span>
                            <input className="field pl-9 pr-10" value={urlFilter} onChange={(event) => setUrlFilter(event.target.value)} placeholder="Filter by URL" spellCheck={false} />
                            {urlFilter ? (
                                <button className="icon-action-button absolute right-1.5 top-1/2 z-10 h-7 w-7 -translate-y-1/2 border-transparent bg-transparent text-ink/55 hover:bg-black/[0.05]" onClick={() => setUrlFilter('')} title="Clear URL filter" type="button">
                                    <CloseIcon />
                                </button>
                            ) : null}
                        </div>
                        <div className="relative z-10">
                            <span className="pointer-events-none absolute left-3 top-1/2 z-10 -translate-y-1/2 text-ink/35">
                                <SearchIcon />
                            </span>
                            <input className="field pl-9 pr-10" value={treeFilter} onChange={(event) => setTreeFilter(event.target.value)} placeholder="Filter folders and requests" spellCheck={false} />
                            {treeFilter ? (
                                <button className="icon-action-button absolute right-1.5 top-1/2 z-10 h-7 w-7 -translate-y-1/2 border-transparent bg-transparent text-ink/55 hover:bg-black/[0.05]" onClick={() => setTreeFilter('')} title="Clear filter" type="button">
                                    <CloseIcon />
                                </button>
                            ) : null}
                        </div>
                    </div>

                    <div className="border-b border-black/8 px-4 py-3" data-folder-drop-type="folder" data-folder-path="" onDragOver={handleRequestDragOverFolder} onDrop={(event) => handleRequestDropOnFolder(event, '')}>
                        <div className="flex items-center justify-between gap-3">
                            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-ink/45">Workspace</p>
                            <div className="flex items-center gap-2">
                                <button className="icon-action-button" onClick={() => openComposer('folder')} title="Create folder at root" disabled={!workspacePath || isBusy}>
                                    <NewFolderIcon />
                                </button>
                                <button className="icon-action-button" onClick={() => openComposer('request')} title="Create request at root" disabled={!workspacePath || isBusy}>
                                    <NewRequestIcon />
                                </button>
                            </div>
                        </div>
                    </div>

                    <div ref={treeScrollRef} className="min-h-0 flex-1 overflow-auto px-3 py-3">
                        {requests.length === 0 && folders.length === 0 ? (
                            <div className="rounded-xl bg-[#e6d7c1]/82 px-3 py-4 text-sm text-ink/65">
                                <p className="font-semibold text-ink">No requests yet.</p>
                                <p className="mt-1">Create one or import an existing workspace.</p>
                            </div>
                        ) : (
                            <TreeSection node={filteredTree || { folders: [], requests: [] }} activeRequestId={activeRequestId} onOpenRequest={openRequest} onRenameRequest={renameRequestFromTree} onDeleteRequest={deleteRequest} onDuplicateRequest={duplicateRequest} onCreateFolder={(path) => openComposer('folder', path)} onCreateRequest={(path) => openComposer('request', path)} onDeleteFolder={deleteFolder} onRenameFolder={renameFolder} draggedRequestId={draggedRequestId} requestDropTarget={requestDropTarget} onRequestDragStart={startRequestDrag} onRequestDragEnd={clearRequestDrag} onRequestDragOverFolder={handleRequestDragOverFolder} onRequestDragOverRequest={handleRequestDragOverRequest} onRequestDragOverGap={handleRequestDragOverGap} onRequestDropOnFolder={handleRequestDropOnFolder} onRequestDropOnRequest={handleRequestDropOnRequest} onRequestDropOnGap={handleRequestDropOnGap} draggedFolderPath={draggedFolderPath} folderDropTarget={folderDropTarget} onFolderDragStart={startFolderDrag} onFolderDragEnd={clearFolderDrag} expandedFolderPathSet={expandedFolderPathSet} onToggleFolder={toggleFolderExpansion} emptyMessage={(treeFilter || urlFilter) ? 'No folders or requests match this filter.' : 'This folder is empty.'} />
                        )}
                    </div>

                    <div className="border-t border-black/8 px-4 py-3 text-xs text-ink/60">{status}</div>
                </aside>

                <div className="flex items-stretch justify-center bg-[#78664d]">
                    <button className="pane-resizer" onMouseDown={() => startPaneResize('left')} aria-label="Resize workspace panel" title="Resize workspace panel">
                        <span className="pane-resizer__grip"></span>
                    </button>
                </div>

                <main className="flex min-h-0 min-w-0 h-full flex-col overflow-hidden bg-[#c3b297]">
                    <div className="border-b border-black/10 bg-[#8f7b60] px-2 pb-0 pt-1.5">
                        <RequestTabs tabs={visibleTabs} requests={requests} activeRequestId={activeRequestId} draggedTabId={draggedTabId} onSelect={openRequest} onRename={updateRequest} onClose={closeTab} onTabDragStart={startTabDrag} onTabDragOver={reorderTabs} onTabDragEnd={clearTabDrag} />
                    </div>

                    <div ref={requestContentScrollRef} className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto px-2.5 pb-2.5 pt-1.5">
                        {activeRequest ? (
                            <div className="grid min-h-full min-w-0 content-start gap-2.5 lg:grid-rows-[auto_auto_auto_minmax(320px,1fr)]">
                                <section className="min-w-0 rounded-2xl border border-black/5 bg-[#e2d0b4]/88 p-2.5">
                                    <div className="grid min-w-0 gap-2 lg:grid-cols-[108px_minmax(0,1fr)_96px_42px_42px]">
                                        <select className="field h-[42px] px-2.5 py-1.5" value={activeRequest.method} onChange={(event) => updateRequest(activeRequest.id, (current) => ({ ...current, method: event.target.value }))}>
                                            {METHOD_OPTIONS.map((method) => (
                                                <option key={method} value={method}>
                                                    {method}
                                                </option>
                                            ))}
                                        </select>
                                        <EnvironmentAutocompleteInput className="field h-[42px] px-2.5 py-1.5" value={activeRequest.url} onChange={(value) => updateRequest(activeRequest.id, (current) => ({ ...current, url: value }))} onSubmit={runRequest} placeholder="{{base_url}}/api/v1/resource" variableNames={activeEnvironmentVariableNames} variableValues={activeEnvironmentVariables} />
                                        <button className="primary-button h-[42px] px-3 py-1.5" onClick={runRequest} disabled={isBusy}>
                                            Send
                                        </button>
                                        <button className="icon-action-button h-[42px] w-[42px]" onClick={exportActiveRequest} title="Export request" aria-label="Export request" disabled={!activeRequest || isBusy} type="button">
                                            <ExportIcon />
                                        </button>
                                        <button className="icon-action-button h-[42px] w-[42px]" onClick={copyActiveRequestAsCurl} title="Open cURL command" aria-label="Open cURL command" disabled={!activeRequest || isBusy} type="button">
                                            <TerminalIcon />
                                        </button>
                                    </div>
                                </section>

                                <section className="min-w-0 rounded-2xl border border-black/5 bg-[#e2d0b4]/88">
                                    <EditorTabBar tabs={REQUEST_EDITOR_TABS} activeTab={activeRequestEditorTab} onSelect={(tab) => setRequestEditorTabById((previous) => ({ ...previous, [activeRequest.id]: tab }))} />
                                    <div className="min-w-0 p-2.5">
                                        {activeRequestEditorTab === 'query' ? <KeyValueTable title="Query Parameters" rows={activeRequest.query_params} onChange={(rows) => updateRequest(activeRequest.id, (current) => ({ ...current, query_params: rows }))} variableNames={activeEnvironmentVariableNames} variableValues={activeEnvironmentVariables} emptyMessage="No query parameters yet." /> : null}
                                        {activeRequestEditorTab === 'headers' ? <KeyValueTable title="Headers" rows={activeRequest.headers} onChange={(rows) => updateRequest(activeRequest.id, (current) => ({ ...current, headers: rows }))} variableNames={activeEnvironmentVariableNames} variableValues={activeEnvironmentVariables} emptyMessage="No headers yet." /> : null}
                                        {activeRequestEditorTab === 'body' ? <BodyEditor request={activeRequest} onChange={(body) => updateRequest(activeRequest.id, (current) => ({ ...current, body }))} onBeautify={beautifyRequestBody} variableNames={activeEnvironmentVariableNames} variableValues={activeEnvironmentVariables} /> : null}
                                        {activeRequestEditorTab === 'auth' ? <AuthEditor request={activeRequest} onChange={(auth) => updateRequest(activeRequest.id, (current) => ({ ...current, auth }))} onFetchToken={(oauth2) => fetchOAuth2Token(activeRequest.id, oauth2)} variableNames={activeEnvironmentVariableNames} variableValues={activeEnvironmentVariables} accessTokenSectionRef={authAccessTokenSectionRef} /> : null}
                                    </div>
                                </section>

                                <div ref={responseSectionRef} className="flex items-center justify-between border-t border-black/10 px-0.5 pt-1">
                                    <div>
                                        <p className="text-xs font-semibold uppercase tracking-[0.22em] text-ink/45">Response</p>
                                    </div>
                                    {activeResponse ? <span className="rounded-full bg-ink px-2.5 py-0.5 text-xs font-semibold text-paper">{activeResponse.status} • {activeResponse.durationMs} ms</span> : null}
                                </div>

                                <ResponseTabs response={activeResponse} activeTab={activeResponseTab} onSelect={(tab) => setResponseTabById((previous) => ({ ...previous, [activeRequest.id]: tab }))} onOpenBodyPopup={(viewer) => setResponseViewer(viewer)} />
                            </div>
                        ) : (
                            <EmptyState isReady={isWorkspaceReady} workspacePath={workspacePath} workspaceName={workspaceName} onCreateRequest={() => openComposer('request')} onCreateWorkspace={() => openComposer('workspace')} onImportWorkspace={importManagedWorkspace} isBusy={isBusy} />
                        )}
                    </div>
                </main>

                <div className="flex items-stretch justify-center bg-[#78664d]">
                    <button className="pane-resizer" onMouseDown={() => startPaneResize('right')} aria-label="Resize environments panel" title="Resize environments panel">
                        <span className="pane-resizer__grip"></span>
                    </button>
                </div>

                <aside className="flex min-h-0 h-full flex-col overflow-hidden bg-[#aa9678]">
                    <EnvironmentPanel environments={normalizedEnvironments} baseEnvironment={baseEnvironment} onChange={updateEnvironments} onAddEnvironment={addEnvironment} activeEnvironment={activeEnvironment} onRenameVariableUsages={renameEnvironmentVariableUsages} />
                </aside>

                {draggedRequest && requestDragState
                    ? createPortal(
                        <div
                            className="fixed z-[250] flex items-center gap-2 rounded-lg border border-black/15 bg-[#e0cfb3]/95 px-3 py-2 text-ink shadow-2xl"
                            style={{
                                left: `${requestDragState.x - requestDragState.offsetX}px`,
                                top: `${requestDragState.y - requestDragState.offsetY}px`,
                                width: `${requestDragState.width}px`,
                                pointerEvents: 'none',
                                transform: 'rotate(1deg)',
                            }}
                        >
                            <div className="icon-action-button h-7 w-7 cursor-grab">
                                <DragHandleIcon />
                            </div>
                            <span className="flex min-w-0 flex-1 items-center gap-2 truncate font-medium">
                                <RequestIcon />
                                <span className="truncate">{draggedRequest.name}</span>
                            </span>
                            <span className="ml-2 text-[11px] font-semibold tracking-wide opacity-70">{draggedRequest.method}</span>
                        </div>,
                        document.body,
                    )
                    : null}

                {composer.open ? <CreateItemDialog composer={composer} setComposer={setComposer} onClose={closeComposer} onSubmit={submitComposer} isBusy={isBusy} /> : null}
                {workspaceExportDialog ? <WorkspaceExportDialog workspace={workspaceExportDialog} onClose={() => setWorkspaceExportDialog(null)} onSubmit={exportWorkspace} isBusy={isBusy} /> : null}
                {draggedFolderPath && folderDragState
                    ? createPortal(
                        <div
                            className="pointer-events-none fixed z-[80] rounded-xl border border-black/15 bg-[#bea685]/95 px-3 py-2 shadow-[0_18px_50px_rgba(15,23,42,0.22)] backdrop-blur"
                            style={{
                                left: `${folderDragState.x - folderDragState.offsetX}px`,
                                top: `${folderDragState.y - folderDragState.offsetY}px`,
                                width: `${folderDragState.width}px`,
                            }}
                        >
                            <div className="flex items-center gap-2 text-sm font-semibold text-ink">
                                <FolderIcon />
                                <span className="truncate">{draggedFolderName}</span>
                            </div>
                        </div>,
                        document.body,
                    )
                    : null}
                {responseViewer ? <ResponseBodyDialog viewer={responseViewer} onClose={() => setResponseViewer(null)} /> : null}
                {curlViewer ? <CommandDialog viewer={curlViewer} onClose={() => setCurlViewer(null)} /> : null}
            </div>
        </div>
    );
}

function EmptyState({ isReady, workspacePath, workspaceName, onCreateRequest, onCreateWorkspace, onImportWorkspace, isBusy }) {
    return (
        <div className="flex h-full items-center justify-center rounded-3xl border border-dashed border-black/10 bg-[#e7dac4]/72">
            <div className="max-w-xl text-center">
                <p className="text-xs font-semibold uppercase tracking-[0.26em] text-ink/45">Request Editor</p>
                <h2 className="mt-3 text-3xl font-black tracking-tight">Open a request tab or create a new request.</h2>
                <p className="mt-3 text-sm leading-6 text-ink/70">{isReady ? `Current workspace: ${workspaceName || 'Workspace'} (${workspacePath})` : 'Preparing the default managed workspace.'}</p>
                <div className="mt-6 flex flex-wrap justify-center gap-3">
                    <button className="primary-button" onClick={onCreateRequest} disabled={!workspacePath || isBusy}>
                        New Request
                    </button>
                    <button className="ghost-button" onClick={onCreateWorkspace} disabled={isBusy}>
                        New Workspace
                    </button>
                    <ImportWorkspaceMenu onImportWorkspace={onImportWorkspace} isBusy={isBusy} buttonClassName="ghost-button" withIcon={false} align="center" />
                </div>
            </div>
        </div>
    );
}

function ImportWorkspaceMenu({ onImportWorkspace, isBusy, buttonClassName = 'ghost-button inline-flex items-center gap-2 px-2.5 py-1.5', withIcon = true, align = 'left' }) {
    const rootRef = useRef(null);
    const [open, setOpen] = useState(false);

    useEffect(() => {
        if (!open) {
            return;
        }

        function handlePointerDown(event) {
            if (!rootRef.current?.contains(event.target)) {
                setOpen(false);
            }
        }

        window.addEventListener('pointerdown', handlePointerDown);
        return () => window.removeEventListener('pointerdown', handlePointerDown);
    }, [open]);

    async function handleImport(source) {
        setOpen(false);
        await onImportWorkspace(source);
    }

    return (
        <div ref={rootRef} className="relative inline-flex">
            <button className={buttonClassName} onClick={() => setOpen((previous) => !previous)} title="Import workspace" disabled={isBusy} type="button" aria-haspopup="menu" aria-expanded={open}>
                {withIcon ? <ImportIcon /> : null}
                <span>Import Workspace</span>
                <ChevronDownIcon />
            </button>
            {open ? (
                <div className={`absolute top-full z-30 mt-2 min-w-[220px] rounded-xl border border-black/10 bg-[#eadbc3] p-1.5 shadow-[0_18px_45px_rgba(15,23,42,0.2)] ${align === 'center' ? 'left-1/2 -translate-x-1/2' : 'left-0'}`} role="menu">
                    <button className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-ink transition hover:bg-black/[0.06]" onClick={() => void handleImport('requii')} disabled={isBusy} type="button" role="menuitem">
                        <ImportIcon />
                        <span>From Requii JSON</span>
                    </button>
                    <button className="mt-1 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-ink transition hover:bg-black/[0.06]" onClick={() => void handleImport('insomnia')} disabled={isBusy} type="button" role="menuitem">
                        <ImportIcon />
                        <span>From Insomnia Export</span>
                    </button>
                </div>
            ) : null}
        </div>
    );
}

function CreateItemDialog({ composer, setComposer, onClose, onSubmit, isBusy }) {
    const label = composer.type === 'request' ? 'request' : composer.type === 'workspace' ? 'workspace' : 'folder';
    const title = composer.type === 'request' ? 'Create Request' : composer.type === 'workspace' ? 'Create Workspace' : 'Create Folder';

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/18 p-4 backdrop-blur-sm">
            <div className="w-full max-w-md rounded-2xl border border-black/15 bg-[#e7dac6] px-5 py-5 shadow-2xl">
                <p className="text-xs font-semibold uppercase tracking-[0.26em] text-ink/45">New {label}</p>
                <h2 className="mt-2 text-2xl font-black tracking-tight">{title}</h2>
                <p className="mt-2 text-sm text-ink/65">{composer.type === 'workspace' ? 'Location: managed Requii storage' : composer.parentPath ? `Location: ${composer.parentPath}` : 'Location: workspace root'}</p>
                <label className="mt-5 block text-sm font-semibold text-ink/70">Name</label>
                <input
                    autoFocus
                    className="field mt-2"
                    value={composer.name}
                    spellCheck={false}
                    onChange={(event) => setComposer((previous) => ({ ...previous, name: event.target.value }))}
                    onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                            onSubmit();
                        }
                    }}
                />
                <div className="mt-5 flex justify-end gap-2">
                    <button className="ghost-button" onClick={onClose} disabled={isBusy}>
                        Cancel
                    </button>
                    <button className="primary-button" onClick={onSubmit} disabled={isBusy || !composer.name.trim()}>
                        Create
                    </button>
                </div>
            </div>
        </div>
    );
}

function collectExportNodeFolderPaths(node) {
    const nextFolderPaths = node?.path ? [node.path] : [];

    for (const folder of node?.folders || []) {
        nextFolderPaths.push(...collectExportNodeFolderPaths(folder));
    }

    return nextFolderPaths;
}

function collectExportNodeRequestIds(node) {
    const nextRequestIds = (node?.requests || []).map((request) => request.id);

    for (const folder of node?.folders || []) {
        nextRequestIds.push(...collectExportNodeRequestIds(folder));
    }

    return nextRequestIds;
}

function WorkspaceExportDialog({ workspace, onClose, onSubmit, isBusy }) {
    const tree = useMemo(() => buildTree(workspace.folders || [], workspace.requests || []), [workspace.folders, workspace.requests]);
    const [exportFilter, setExportFilter] = useState('');
    const [selectedFolderPaths, setSelectedFolderPaths] = useState(() => workspace.folders || []);
    const [selectedRequestIds, setSelectedRequestIds] = useState(() => (workspace.requests || []).map((request) => request.id));
    const [includeEnvironments, setIncludeEnvironments] = useState(true);
    const selectedFolderPathSet = useMemo(() => new Set(selectedFolderPaths), [selectedFolderPaths]);
    const selectedRequestIdSet = useMemo(() => new Set(selectedRequestIds), [selectedRequestIds]);
    const filteredTree = useMemo(() => filterTree(tree, exportFilter), [tree, exportFilter]);
    const hasActiveFilter = exportFilter.trim().length > 0;
    const visibleFolderPaths = useMemo(() => collectExportNodeFolderPaths(filteredTree), [filteredTree]);
    const visibleRequestIds = useMemo(() => collectExportNodeRequestIds(filteredTree), [filteredTree]);
    const effectiveSelectedFolderPaths = useMemo(
        () => (hasActiveFilter ? selectedFolderPaths.filter((folderPath) => visibleFolderPaths.includes(folderPath)) : selectedFolderPaths),
        [hasActiveFilter, selectedFolderPaths, visibleFolderPaths],
    );
    const effectiveSelectedRequestIds = useMemo(
        () => (hasActiveFilter ? selectedRequestIds.filter((requestId) => visibleRequestIds.includes(requestId)) : selectedRequestIds),
        [hasActiveFilter, selectedRequestIds, visibleRequestIds],
    );
    const totalSelectedItems = effectiveSelectedFolderPaths.length + effectiveSelectedRequestIds.length + (includeEnvironments ? 1 : 0);

    useEffect(() => {
        function handleKeyDown(event) {
            if (event.key === 'Escape') {
                onClose();
            }
        }

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [onClose]);

    function handleToggleAll(checked) {
        if (hasActiveFilter) {
            setSelectedFolderPaths((previous) => checked
                ? [...new Set([...previous, ...visibleFolderPaths])]
                : previous.filter((folderPath) => !visibleFolderPaths.includes(folderPath)));
            setSelectedRequestIds((previous) => checked
                ? [...new Set([...previous, ...visibleRequestIds])]
                : previous.filter((requestId) => !visibleRequestIds.includes(requestId)));
            return;
        }

        setSelectedFolderPaths(checked ? [...(workspace.folders || [])] : []);
        setSelectedRequestIds(checked ? (workspace.requests || []).map((request) => request.id) : []);
    }

    function handleToggleFolder(node, checked) {
        const folderPaths = collectExportNodeFolderPaths(node);
        const requestIds = collectExportNodeRequestIds(node);

        setSelectedFolderPaths((previous) => checked ? [...new Set([...previous, ...folderPaths])] : previous.filter((folderPath) => !folderPaths.includes(folderPath)));
        setSelectedRequestIds((previous) => checked ? [...new Set([...previous, ...requestIds])] : previous.filter((requestId) => !requestIds.includes(requestId)));
    }

    function handleToggleRequest(requestId, checked) {
        setSelectedRequestIds((previous) => checked ? [...new Set([...previous, requestId])] : previous.filter((candidateId) => candidateId !== requestId));
    }

    async function handleSubmit() {
        await onSubmit({
            folderPaths: effectiveSelectedFolderPaths,
            requestIds: effectiveSelectedRequestIds,
            includeEnvironments,
        });
    }

    return (
        <div className="fixed inset-0 z-[260] flex items-center justify-center bg-ink/35 p-4 backdrop-blur-sm">
            <div className="flex max-h-[86vh] w-full max-w-4xl flex-col rounded-3xl border border-black/15 bg-[#e7dac6] p-5 shadow-2xl">
                <div className="flex items-start justify-between gap-4">
                    <div>
                        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-ink/45">Workspace Export</p>
                        <h2 className="mt-1 text-2xl font-black tracking-tight text-ink">{workspace.workspaceName}</h2>
                        <p className="mt-2 text-sm text-ink/65">Select the folders, requests, and environments to include in the exported Requii JSON.</p>
                    </div>
                    <button className="icon-action-button" onClick={onClose} title="Close export dialog" type="button">
                        <CloseIcon />
                    </button>
                </div>

                <div className="mt-4 flex flex-wrap items-center gap-2">
                    <button className="ghost-button" onClick={() => handleToggleAll(true)} disabled={isBusy} type="button">{hasActiveFilter ? 'Select Filtered' : 'Select All'}</button>
                    <button className="ghost-button" onClick={() => handleToggleAll(false)} disabled={isBusy} type="button">{hasActiveFilter ? 'Clear Filtered' : 'Clear Requests & Folders'}</button>
                    <label className="ml-auto inline-flex items-center gap-2 rounded-xl border border-black/10 bg-[#eadbc3] px-3 py-2 text-sm text-ink">
                        <input type="checkbox" checked={includeEnvironments} onChange={(event) => setIncludeEnvironments(event.target.checked)} disabled={isBusy} />
                        <span>Include environments.json</span>
                    </label>
                </div>

                <div className="mt-3 relative z-10">
                    <span className="pointer-events-none absolute left-3 top-1/2 z-10 -translate-y-1/2 text-ink/35">
                        <SearchIcon />
                    </span>
                    <input className="field pl-9 pr-10" value={exportFilter} onChange={(event) => setExportFilter(event.target.value)} placeholder="Filter folders and requests" spellCheck={false} />
                    {exportFilter ? (
                        <button className="icon-action-button absolute right-1.5 top-1/2 z-10 h-7 w-7 -translate-y-1/2 border-transparent bg-transparent text-ink/55 hover:bg-black/[0.05]" onClick={() => setExportFilter('')} title="Clear filter" type="button">
                            <CloseIcon />
                        </button>
                    ) : null}
                </div>

                <div className="mt-4 min-h-0 flex-1 overflow-auto rounded-2xl border border-black/10 bg-[#dbc8a9]/72 p-3">
                    {tree.requests.length === 0 && tree.folders.length === 0 ? (
                        <p className="rounded-xl bg-[#e6d7c1]/82 px-3 py-4 text-sm text-ink/65">This workspace has no folders or requests to export.</p>
                    ) : !filteredTree || (filteredTree.requests.length === 0 && filteredTree.folders.length === 0) ? (
                        <p className="rounded-xl bg-[#e6d7c1]/82 px-3 py-4 text-sm text-ink/65">No folders or requests match this filter.</p>
                    ) : (
                        <div className="space-y-1">
                            {(filteredTree.requests || []).map((request) => (
                                <label key={request.id} className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-ink hover:bg-black/[0.04]">
                                    <input type="checkbox" checked={selectedRequestIdSet.has(request.id)} onChange={(event) => handleToggleRequest(request.id, event.target.checked)} disabled={isBusy} />
                                    <RequestIcon />
                                    <span className="truncate font-medium">{request.name}</span>
                                    <span className="ml-auto text-[11px] font-semibold tracking-wide text-ink/55">{request.method}</span>
                                </label>
                            ))}
                            {(filteredTree.folders || []).map((folder) => (
                                <WorkspaceExportTreeNode key={folder.path} node={folder} depth={0} selectedFolderPathSet={selectedFolderPathSet} selectedRequestIdSet={selectedRequestIdSet} onToggleFolder={handleToggleFolder} onToggleRequest={handleToggleRequest} isBusy={isBusy} />
                            ))}
                        </div>
                    )}
                </div>

                <div className="mt-4 flex items-center justify-between gap-3">
                    <p className="text-sm text-ink/62">{effectiveSelectedFolderPaths.length} folders, {effectiveSelectedRequestIds.length} requests, {includeEnvironments ? 'environments included' : 'no environments'}{hasActiveFilter ? ' in current filter.' : '.'}</p>
                    <div className="flex items-center gap-2">
                        <button className="ghost-button" onClick={onClose} disabled={isBusy} type="button">Cancel</button>
                        <button className="primary-button" onClick={() => void handleSubmit()} disabled={isBusy || totalSelectedItems === 0} type="button">Export Selection</button>
                    </div>
                </div>
            </div>
        </div>
    );
}

function WorkspaceExportTreeNode({ node, depth, selectedFolderPathSet, selectedRequestIdSet, onToggleFolder, onToggleRequest, isBusy }) {
    const checkboxRef = useRef(null);
    const descendantFolderPaths = useMemo(() => collectExportNodeFolderPaths(node), [node]);
    const descendantRequestIds = useMemo(() => collectExportNodeRequestIds(node), [node]);
    const totalSelectable = descendantFolderPaths.length + descendantRequestIds.length;
    const selectedCount = descendantFolderPaths.filter((folderPath) => selectedFolderPathSet.has(folderPath)).length
        + descendantRequestIds.filter((requestId) => selectedRequestIdSet.has(requestId)).length;
    const checked = totalSelectable > 0 && selectedCount === totalSelectable;
    const partiallyChecked = selectedCount > 0 && selectedCount < totalSelectable;

    useEffect(() => {
        if (checkboxRef.current) {
            checkboxRef.current.indeterminate = partiallyChecked;
        }
    }, [partiallyChecked]);

    return (
        <div className="space-y-1">
            <label className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-ink hover:bg-black/[0.04]" style={{ paddingLeft: `${depth * 18 + 8}px` }}>
                <input ref={checkboxRef} type="checkbox" checked={checked} onChange={(event) => onToggleFolder(node, event.target.checked)} disabled={isBusy} />
                <FolderIcon />
                <span className="truncate font-semibold">{node.name}</span>
                <span className="ml-auto text-[11px] text-ink/50">{descendantRequestIds.length} requests</span>
            </label>
            {(node.requests || []).map((request) => (
                <label key={request.id} className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-ink hover:bg-black/[0.04]" style={{ paddingLeft: `${depth * 18 + 32}px` }}>
                    <input type="checkbox" checked={selectedRequestIdSet.has(request.id)} onChange={(event) => onToggleRequest(request.id, event.target.checked)} disabled={isBusy} />
                    <RequestIcon />
                    <span className="truncate font-medium">{request.name}</span>
                    <span className="ml-auto text-[11px] font-semibold tracking-wide text-ink/55">{request.method}</span>
                </label>
            ))}
            {(node.folders || []).map((folder) => (
                <WorkspaceExportTreeNode key={folder.path} node={folder} depth={depth + 1} selectedFolderPathSet={selectedFolderPathSet} selectedRequestIdSet={selectedRequestIdSet} onToggleFolder={onToggleFolder} onToggleRequest={onToggleRequest} isBusy={isBusy} />
            ))}
        </div>
    );
}

function ScrollSliderList({ label, maxHeight, children, contentClassName = 'space-y-2' }) {
    return (
        <div className="overflow-y-auto pr-1" style={{ maxHeight }} aria-label={label}>
            <div className={contentClassName}>{children}</div>
        </div>
    );
}

function CommandDialog({ viewer, onClose }) {
    const defaultPlatform = getDefaultCurlPlatform();
    const [platform, setPlatform] = useState<CurlPlatform>(defaultPlatform);
    const [terminal, setTerminal] = useState<CurlTarget>(CURL_PLATFORM_OPTIONS[defaultPlatform].terminals[0].value);
    const [command, setCommand] = useState('');
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState('');
    const terminalOptions = CURL_PLATFORM_OPTIONS[platform].terminals;
    const selectedTerminal = terminalOptions.find((option) => option.value === terminal) || terminalOptions[0];

    useEffect(() => {
        const nextTerminal = CURL_PLATFORM_OPTIONS[platform].terminals[0]?.value || 'powershell';
        if (!CURL_PLATFORM_OPTIONS[platform].terminals.some((option) => option.value === terminal)) {
            setTerminal(nextTerminal);
        }
    }, [platform, terminal]);

    useEffect(() => {
        let cancelled = false;

        async function loadCommand() {
            setIsLoading(true);
            setError('');

            try {
                const nextCommand = await requiiIpc.copyRequestAsCurl(viewer.request, viewer.activeEnvironment, terminal);
                if (!cancelled) {
                    setCommand(nextCommand);
                }
            } catch (nextError) {
                if (!cancelled) {
                    setCommand('');
                    setError(nextError.message || 'Failed to build the cURL command.');
                }
            } finally {
                if (!cancelled) {
                    setIsLoading(false);
                }
            }
        }

        void loadCommand();

        return () => {
            cancelled = true;
        };
    }, [terminal, viewer.activeEnvironment, viewer.request]);

    return (
        <div className="fixed inset-0 z-[260] flex items-center justify-center bg-ink/35 p-4 backdrop-blur-sm">
            <div className="flex w-full max-w-5xl flex-col rounded-3xl border border-black/15 bg-[#d7c19d] p-5 shadow-2xl">
                <div className="flex items-start justify-between gap-4">
                    <div>
                        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-ink/45">Terminal Command</p>
                        <h2 className="mt-1 text-2xl font-black tracking-tight text-ink">{viewer.title}</h2>
                        <p className="mt-2 text-sm text-ink/65">Choose the target OS and terminal, then paste the full command directly into that terminal.</p>
                    </div>
                    <button className="icon-action-button" onClick={onClose} title="Close cURL viewer" type="button">
                        <CloseIcon />
                    </button>
                </div>
                <div className="mt-4 grid gap-3 md:grid-cols-[minmax(0,220px)_minmax(0,220px)_1fr] md:items-end">
                    <label className="block text-sm font-semibold text-ink/70">
                        <span className="mb-1.5 block">OS</span>
                        <select className="field px-2.5 py-1.5" value={platform} onChange={(event) => setPlatform(event.target.value as CurlPlatform)}>
                            {Object.entries(CURL_PLATFORM_OPTIONS).map(([value, option]) => (
                                <option key={value} value={value}>
                                    {option.label}
                                </option>
                            ))}
                        </select>
                    </label>
                    <label className="block text-sm font-semibold text-ink/70">
                        <span className="mb-1.5 block">Terminal</span>
                        <select className="field px-2.5 py-1.5" value={terminal} onChange={(event) => setTerminal(event.target.value as CurlTarget)}>
                            {terminalOptions.map((option) => (
                                <option key={option.value} value={option.value}>
                                    {option.label}
                                </option>
                            ))}
                        </select>
                    </label>
                    <div className="text-sm text-ink/60 md:pb-2">Formatting is tailored for {selectedTerminal.label} on {CURL_PLATFORM_OPTIONS[platform].label}.</div>
                </div>
                {error ? <p className="mt-4 rounded-2xl border border-[#7d2514]/20 bg-[#f0d5cc] px-3 py-2 text-sm text-[#7d2514]">{error}</p> : null}
                <div className="mt-4">
                    <CodeMiniEditor value={isLoading ? 'Generating command...' : command} onChange={() => { }} language={selectedTerminal.language} height="52vh" readOnly />
                </div>
            </div>
        </div>
    );
}

function EnvironmentEditorDialog({ value, onChange, onBeautify, onClose, variableNames, variableValues, error }) {
    useEffect(() => {
        function handleKeyDown(event) {
            if (event.key === 'Escape') {
                onClose();
            }
        }

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [onClose]);

    return (
        <div className="fixed inset-0 z-[260] flex items-center justify-center bg-ink/35 p-4 backdrop-blur-sm">
            <div className="flex h-[min(88vh,920px)] w-full max-w-6xl flex-col rounded-3xl border border-black/15 bg-[#d7c19d] p-5 shadow-2xl">
                <div className="flex items-start justify-between gap-4">
                    <div>
                        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-ink/45">Environment Variables</p>
                        <h2 className="mt-1 text-2xl font-black tracking-tight text-ink">Expanded JSON Editor</h2>
                        <p className="mt-2 text-sm text-ink/65">Edit the active environment with more space. Changes save through the same validation flow as the mini editor.</p>
                    </div>
                    <button className="icon-action-button" onClick={onClose} title="Close expanded editor" type="button">
                        <CloseIcon />
                    </button>
                </div>
                <div className="mt-4 min-h-0 flex-1 rounded-2xl border border-black/10 bg-[#e3d1b5]/72 p-3">
                    <CodeMiniEditor
                        modelPath="inmemory://environment-editor-dialog/active.json"
                        value={value}
                        onChange={onChange}
                        language="json"
                        placeholder={'{\n  "base_url": "https://api.example.com",\n  "auth": {\n    "client_secret": "..."\n  }\n}'}
                        variableNames={variableNames}
                        variableValues={variableValues}
                        fillContainer
                        headerActions={
                            <button
                                className="icon-action-button h-6 w-6 border-transparent bg-transparent text-ink/60 hover:bg-black/[0.05]"
                                onClick={onBeautify}
                                title="Beautify environment JSON"
                                type="button"
                            >
                                <BeautifyIcon />
                            </button>
                        }
                    />
                    {error ? <p className="mt-3 text-sm text-[#8f1d1d]">{error}</p> : null}
                </div>
            </div>
        </div>
    );
}

function EnvironmentAutocompleteInput({ variableNames, variableValues, onChange, value, className = '', onSubmit = null, ...props }) {
    return <EnvironmentAutocompleteField as="input" variableNames={variableNames} variableValues={variableValues} onChange={onChange} value={value} className={className} onSubmit={onSubmit} {...props} />;
}

function EnvironmentAutocompleteTextarea({ variableNames, variableValues, onChange, value, className = '', onSubmit = null, ...props }) {
    return <EnvironmentAutocompleteField as="textarea" variableNames={variableNames} variableValues={variableValues} onChange={onChange} value={value} className={className} onSubmit={onSubmit} {...props} />;
}

function filterStaticAutocompleteSuggestions(suggestions = [], query = '') {
    const normalizedQuery = String(query || '').trim().toLowerCase();
    return [...suggestions]
        .filter((suggestion) => {
            if (!normalizedQuery) {
                return true;
            }
            const value = String(suggestion?.value || '').toLowerCase();
            const detail = String(suggestion?.detail || '').toLowerCase();
            return value.includes(normalizedQuery) || detail.includes(normalizedQuery);
        })
        .sort((left, right) => {
            const leftValue = String(left?.value || '');
            const rightValue = String(right?.value || '');
            const leftStarts = leftValue.toLowerCase().startsWith(normalizedQuery);
            const rightStarts = rightValue.toLowerCase().startsWith(normalizedQuery);
            if (leftStarts !== rightStarts) {
                return leftStarts ? -1 : 1;
            }
            return leftValue.localeCompare(rightValue);
        });
}

function EnvironmentAutocompleteField({ as = 'input', variableNames = [], variableValues = {}, onChange, onSubmit = null, value = '', className = '', supplementalSuggestions = [], suggestionsLabel = 'Environment Variables', ...props }) {
    const rootRef = useRef(null);
    const popupRef = useRef(null);
    const suggestionsListRef = useRef(null);
    const inputRef = useRef(null);
    const mirrorRef = useRef(null);
    const pendingSelectionRef = useRef(null);
    const [cursorPosition, setCursorPosition] = useState(value.length);
    const [isFocused, setIsFocused] = useState(false);
    const [manualOpen, setManualOpen] = useState(false);
    const [suppressAutoOpen, setSuppressAutoOpen] = useState(false);
    const [highlightedIndex, setHighlightedIndex] = useState(0);
    const [anchorPosition, setAnchorPosition] = useState({ left: 0, top: 0, height: 0, width: 280, maxHeight: 260 });
    const [mirrorScroll, setMirrorScroll] = useState({ left: 0, top: 0 });
    const [hoverPreview, setHoverPreview] = useState(null);

    const context = useMemo(() => getEnvironmentAutocompleteContext(value, cursorPosition, manualOpen), [value, cursorPosition, manualOpen]);
    const interpolationMatches = useMemo(() => getEnvironmentInterpolationMatches(value, variableValues), [value, variableValues]);
    const environmentSuggestions = useMemo(() => {
        if (!context) {
            return [];
        }
        return getEnvironmentSuggestions(variableNames, context.query).map((suggestion) => ({
            kind: 'environment',
            value: suggestion,
            detail: 'Environment variable',
        }));
    }, [context, variableNames]);
    const staticSuggestions = useMemo(() => {
        if (!context) {
            return [];
        }
        return filterStaticAutocompleteSuggestions(supplementalSuggestions, context.query).map((suggestion) => ({
            kind: 'static',
            value: suggestion.value,
            detail: suggestion.detail || 'Suggestion',
        }));
    }, [context, supplementalSuggestions]);
    const suggestions = useMemo(() => {
        const combined = [...staticSuggestions, ...environmentSuggestions];
        const seen = new Set();
        return combined.filter((suggestion) => {
            const key = `${suggestion.kind}:${String(suggestion.value).toLowerCase()}`;
            if (seen.has(key)) {
                return false;
            }
            seen.add(key);
            return true;
        });
    }, [environmentSuggestions, staticSuggestions]);
    const visibleSuggestions = useMemo(() => {
        const maxSuggestions = 8;
        if (suggestions.length <= maxSuggestions) {
            return suggestions;
        }

        const visibleStaticSuggestions = suggestions.filter((suggestion) => suggestion.kind === 'static');
        const visibleEnvironmentSuggestions = suggestions.filter((suggestion) => suggestion.kind === 'environment');

        if (!visibleStaticSuggestions.length || !visibleEnvironmentSuggestions.length) {
            return suggestions.slice(0, maxSuggestions);
        }

        const staticTarget = Math.min(4, visibleStaticSuggestions.length);
        const environmentTarget = Math.min(4, visibleEnvironmentSuggestions.length);
        const selected = [...visibleStaticSuggestions.slice(0, staticTarget), ...visibleEnvironmentSuggestions.slice(0, environmentTarget)];
        const seen = new Set(selected.map((suggestion) => `${suggestion.kind}:${String(suggestion.value).toLowerCase()}`));

        for (const suggestion of suggestions) {
            if (selected.length >= maxSuggestions) {
                break;
            }

            const key = `${suggestion.kind}:${String(suggestion.value).toLowerCase()}`;
            if (seen.has(key)) {
                continue;
            }

            seen.add(key);
            selected.push(suggestion);
        }

        return selected;
    }, [suggestions]);
    const suggestionPopupWidth = useMemo(() => {
        const baseWidth = 280;
        const widestSuggestionLength = visibleSuggestions.reduce((longest, suggestion) => {
            const valueLength = String(suggestion?.value || '').trim().length;
            return Math.max(longest, valueLength);
        }, 0);

        return Math.min(420, baseWidth + Math.min(120, Math.max(0, widestSuggestionLength - 18) * 5));
    }, [visibleSuggestions]);
    const firstEnvironmentSuggestionIndex = useMemo(() => visibleSuggestions.findIndex((suggestion) => suggestion.kind === 'environment'), [visibleSuggestions]);
    const hasStaticSuggestions = firstEnvironmentSuggestionIndex > 0;
    const isOpen = isFocused && !suppressAutoOpen && suggestions.length > 0 && Boolean(context) && (manualOpen || context.query.length >= ENV_AUTOCOMPLETE_MIN_LENGTH);
    const canShowHoverPreview = interpolationMatches.length > 0;
    const shouldRenderStyledOverlay = interpolationMatches.length > 0 && !isFocused;
    const inputClassName = shouldRenderStyledOverlay ? `${className} env-field env-field__input` : `${className} env-field`;
    useEffect(() => {
        if (highlightedIndex >= visibleSuggestions.length) {
            setHighlightedIndex(0);
        }
    }, [highlightedIndex, visibleSuggestions.length]);

    useEffect(() => {
        if (!isOpen && manualOpen) {
            setManualOpen(false);
        }
    }, [isOpen, manualOpen]);

    useEffect(() => {
        if (manualOpen && suppressAutoOpen) {
            setSuppressAutoOpen(false);
        }
    }, [manualOpen, suppressAutoOpen]);

    useEffect(() => {
        if (!isOpen) {
            return;
        }

        function handleDocumentAutocompleteKeyDown(event) {
            if (event.defaultPrevented || event.isComposing) {
                return;
            }

            const isInputFocused = event.target === inputRef.current;
            if (isInputFocused) {
                return;
            }

            if (event.key === 'ArrowDown') {
                event.preventDefault();
                setHighlightedIndex((previous) => (previous + 1) % visibleSuggestions.length);
                return;
            }

            if (event.key === 'ArrowUp') {
                event.preventDefault();
                setHighlightedIndex((previous) => (previous - 1 + visibleSuggestions.length) % visibleSuggestions.length);
                return;
            }

            if (event.key === 'Enter' || event.key === 'Tab') {
                event.preventDefault();
                commitSuggestion(visibleSuggestions[highlightedIndex] ?? visibleSuggestions[0]);
                return;
            }

            if (event.key === 'Escape') {
                event.preventDefault();
                closeSuggestions();
            }
        }

        document.addEventListener('keydown', handleDocumentAutocompleteKeyDown, true);
        return () => document.removeEventListener('keydown', handleDocumentAutocompleteKeyDown, true);
    }, [highlightedIndex, isOpen, visibleSuggestions]);

    useEffect(() => {
        if (isOpen && hoverPreview) {
            setHoverPreview(null);
        }
    }, [hoverPreview, isOpen]);

    useEffect(() => {
        if (!canShowHoverPreview && hoverPreview) {
            setHoverPreview(null);
        }
    }, [canShowHoverPreview, hoverPreview]);

    useEffect(() => {
        if (!isOpen || !inputRef.current) {
            return;
        }

        function updateAnchor() {
            if (!inputRef.current) {
                return;
            }

            const inputElement = inputRef.current;
            const inputRect = inputElement.getBoundingClientRect();
            const computedStyle = window.getComputedStyle(inputElement);
            const lineHeight = Number.parseFloat(computedStyle.lineHeight) || Number.parseFloat(computedStyle.fontSize) * 1.4 || 20;
            const width = Math.min(420, Math.max(Math.max(260, inputRect.width), suggestionPopupWidth));
            const maxLeft = Math.max(12, window.innerWidth - width - 12);
            const left = Math.min(Math.max(12, inputRect.left), maxLeft);
            const belowTop = inputRect.bottom + 6;
            const availableBelow = window.innerHeight - belowTop - 12;
            const availableAbove = inputRect.top - 12;
            const preferredHeight = 260;

            if (availableBelow >= 140 || availableBelow >= availableAbove) {
                setAnchorPosition({
                    left,
                    top: Math.max(12, belowTop),
                    height: lineHeight,
                    width,
                    maxHeight: Math.max(140, Math.min(preferredHeight, availableBelow)),
                });
                return;
            }

            const popupHeight = Math.max(140, Math.min(preferredHeight, availableAbove));
            const top = Math.max(12, inputRect.top - popupHeight - 6);

            setAnchorPosition({ left, top, height: lineHeight, width, maxHeight: popupHeight });
        }

        updateAnchor();
        const element = inputRef.current;
        element.addEventListener('scroll', updateAnchor);
        window.addEventListener('resize', updateAnchor);
        window.addEventListener('scroll', updateAnchor, true);

        return () => {
            element.removeEventListener('scroll', updateAnchor);
            window.removeEventListener('resize', updateAnchor);
            window.removeEventListener('scroll', updateAnchor, true);
        };
    }, [highlightedIndex, isOpen, suggestionPopupWidth, value]);

    useEffect(() => {
        if (!isOpen || !suggestionsListRef.current) {
            return;
        }

        const activeElement = suggestionsListRef.current.querySelector('[data-autocomplete-active="true"]');
        activeElement?.scrollIntoView({ block: 'nearest' });
    }, [highlightedIndex, isOpen, visibleSuggestions]);

    useEffect(() => {
        if (!isOpen) {
            return;
        }

        function handleDocumentPointerDown(event) {
            const target = event.target;
            if (rootRef.current?.contains(target) || popupRef.current?.contains(target)) {
                return;
            }

            closeSuggestions();
            clearHoverPreview();
        }

        document.addEventListener('pointerdown', handleDocumentPointerDown, true);
        return () => document.removeEventListener('pointerdown', handleDocumentPointerDown, true);
    }, [isOpen]);

    useEffect(() => {
        if (!pendingSelectionRef.current || !inputRef.current) {
            return;
        }

        const { start, end } = pendingSelectionRef.current;
        pendingSelectionRef.current = null;
        inputRef.current.focus();
        inputRef.current.setSelectionRange(start, end);
    }, [value]);

    function closeSuggestions({ suppress = true } = {}) {
        setManualOpen(false);
        setHighlightedIndex(0);
        if (suppress) {
            setSuppressAutoOpen(true);
        }
    }

    function clearHoverPreview() {
        setHoverPreview(null);
    }

    function syncCursor(target) {
        setCursorPosition(target.selectionStart ?? target.value.length);
    }

    function applyNativeSuggestionInsertion(replaceStart, replaceEnd, insertedValue) {
        const inputElement = inputRef.current;
        if (!inputElement) {
            return false;
        }

        inputElement.focus();
        inputElement.setSelectionRange(replaceStart, replaceEnd);

        const commandSucceeded = typeof document !== 'undefined' && typeof document.execCommand === 'function'
            ? document.execCommand('insertText', false, insertedValue)
            : false;

        if (!commandSucceeded) {
            inputElement.setRangeText(insertedValue, replaceStart, replaceEnd, 'end');
            inputElement.dispatchEvent(new Event('input', { bubbles: true }));
        }

        const nextCursor = inputElement.selectionStart ?? (replaceStart + insertedValue.length);
        pendingSelectionRef.current = { start: nextCursor, end: nextCursor };
        setCursorPosition(nextCursor);
        return true;
    }

    function commitSuggestion(suggestion) {
        if (!suggestion) {
            return;
        }

        const liveValue = inputRef.current?.value ?? value;
        const liveCursorPosition = inputRef.current?.selectionStart ?? cursorPosition;
        const activeContext = getEnvironmentAutocompleteContext(liveValue, liveCursorPosition, true) || context;

        if (!activeContext) {
            return;
        }

        let insertedValue;

        if (suggestion.kind === 'static') {
            insertedValue = suggestion.value;
        } else if (activeContext.mode === 'inside-braces') {
            const hasClosingBraces = liveValue.slice(activeContext.replaceEnd, activeContext.replaceEnd + 2) === '}}';
            const suffix = hasClosingBraces ? '' : '}}';
            insertedValue = `${suggestion.value}${suffix}`;
        } else {
            insertedValue = `{{${suggestion.value}}}`;
        }

        if (!applyNativeSuggestionInsertion(activeContext.replaceStart, activeContext.replaceEnd, insertedValue)) {
            const nextValue = `${liveValue.slice(0, activeContext.replaceStart)}${insertedValue}${liveValue.slice(activeContext.replaceEnd)}`;
            const nextCursor = activeContext.replaceStart + insertedValue.length;
            pendingSelectionRef.current = { start: nextCursor, end: nextCursor };
            onChange(nextValue);
            setCursorPosition(nextCursor);
        }

        closeSuggestions({ suppress: true });
    }

    function handleChange(event) {
        if (suppressAutoOpen) {
            setSuppressAutoOpen(false);
        }
        syncCursor(event.target);
        onChange(event.target.value);
    }

    function handleScroll(event) {
        setMirrorScroll({
            left: event.currentTarget.scrollLeft || 0,
            top: event.currentTarget.scrollTop || 0,
        });
    }

    function handleKeyDown(event) {
        if (event.nativeEvent?.isComposing) {
            return;
        }

        if (event.ctrlKey && event.key === ' ') {
            event.preventDefault();
            setSuppressAutoOpen(false);
            syncCursor(event.currentTarget);
            setManualOpen(true);
            setHighlightedIndex(0);
            return;
        }

        if (event.key === 'Enter' && as === 'input' && typeof onSubmit === 'function' && !isOpen) {
            event.preventDefault();
            onSubmit();
            return;
        }

        if (!isOpen) {
            return;
        }

        if (event.key === 'ArrowDown') {
            event.preventDefault();
            setHighlightedIndex((previous) => (previous + 1) % visibleSuggestions.length);
            return;
        }

        if (event.key === 'ArrowUp') {
            event.preventDefault();
            setHighlightedIndex((previous) => (previous - 1 + visibleSuggestions.length) % visibleSuggestions.length);
            return;
        }

        if (event.key === 'Enter' || event.key === 'Tab') {
            event.preventDefault();
            syncCursor(event.currentTarget);
            commitSuggestion(visibleSuggestions[highlightedIndex] ?? visibleSuggestions[0]);
            return;
        }

        if (event.key === 'Escape') {
            event.preventDefault();
            closeSuggestions({ suppress: true });
            return;
        }
    }

    function handleBlur() {
        setIsFocused(false);
        closeSuggestions({ suppress: true });
        clearHoverPreview();
    }

    function handleFocus(event) {
        setIsFocused(true);
        syncCursor(event.target);
    }

    function handleClick(event) {
        syncCursor(event.target);
    }

    function handleKeyUp(event) {
        syncCursor(event.currentTarget);
    }

    function handleSelect(event) {
        syncCursor(event.currentTarget);
    }

    function handleMouseMove(event) {
        if (!canShowHoverPreview || isOpen || !mirrorRef.current) {
            if (hoverPreview) {
                clearHoverPreview();
            }
            return;
        }

        const tokenElements = mirrorRef.current.querySelectorAll('[data-env-token-index]');
        let nextMatch = null;

        tokenElements.forEach((element) => {
            if (nextMatch) {
                return;
            }

            const rect = element.getBoundingClientRect();
            const withinX = event.clientX >= rect.left && event.clientX <= rect.right;
            const withinY = event.clientY >= rect.top && event.clientY <= rect.bottom;

            if (!withinX || !withinY) {
                return;
            }

            const tokenIndex = Number(element.getAttribute('data-env-token-index'));
            nextMatch = interpolationMatches[tokenIndex] || null;
        });

        if (!nextMatch) {
            if (hoverPreview) {
                clearHoverPreview();
            }
            return;
        }

        const tooltipWidth = 360;
        const tooltipHeight = 120;
        const left = Math.min(event.clientX + 14, window.innerWidth - tooltipWidth - 12);
        const top = Math.min(event.clientY + 16, window.innerHeight - tooltipHeight - 12);

        setHoverPreview({ match: nextMatch, left: Math.max(12, left), top: Math.max(12, top) });
    }

    function renderMirrorContent() {
        if (!value) {
            return null;
        }

        if (interpolationMatches.length === 0) {
            return value;
        }

        const parts = [];
        let currentIndex = 0;

        interpolationMatches.forEach((match, index) => {
            if (match.start > currentIndex) {
                parts.push(
                    <span key={`text-${index}`} className="env-token-text">
                        {value.slice(currentIndex, match.start)}
                    </span>,
                );
            }

            parts.push(
                <span key={`token-${match.start}-${match.end}`} data-env-token-index={index} className={`env-token ${match.found ? 'env-token--found' : 'env-token--missing'}`}>
                    {match.raw}
                </span>,
            );
            currentIndex = match.end;
        });

        if (currentIndex < value.length) {
            parts.push(
                <span key="text-end" className="env-token-text">
                    {value.slice(currentIndex)}
                </span>,
            );
        }

        return parts;
    }

    return (
        <div ref={rootRef} className="relative">
            {shouldRenderStyledOverlay ? (
                <div className="pointer-events-none absolute inset-0 z-[2] overflow-hidden" aria-hidden="true">
                    <div
                        ref={mirrorRef}
                        className={`${className} env-field env-field__mirror h-full overflow-hidden ${as === 'textarea' ? 'whitespace-pre-wrap break-words' : 'whitespace-pre'}`}
                        style={{ transform: `translate(${-mirrorScroll.left}px, ${-mirrorScroll.top}px)` }}
                    >
                        {renderMirrorContent()}
                    </div>
                </div>
            ) : null}
            {as === 'textarea' ? (
                <textarea ref={inputRef} className={inputClassName} value={value} spellCheck={false} onChange={handleChange} onKeyDown={handleKeyDown} onKeyUp={handleKeyUp} onClick={handleClick} onFocus={handleFocus} onBlur={handleBlur} onSelect={handleSelect} onScroll={handleScroll} onMouseMove={handleMouseMove} onMouseLeave={clearHoverPreview} {...props} />
            ) : (
                <input ref={inputRef} className={inputClassName} value={value} spellCheck={false} onChange={handleChange} onKeyDown={handleKeyDown} onKeyUp={handleKeyUp} onClick={handleClick} onFocus={handleFocus} onBlur={handleBlur} onSelect={handleSelect} onScroll={handleScroll} onMouseMove={handleMouseMove} onMouseLeave={clearHoverPreview} {...props} />
            )}
            {isOpen
                ? createPortal(
                    <div ref={popupRef} className="fixed z-[200] overflow-hidden rounded-xl border border-black/15 bg-[#e7dac6] shadow-2xl" style={{ left: `${anchorPosition.left}px`, top: `${anchorPosition.top}px`, width: `${anchorPosition.width}px`, maxHeight: `${anchorPosition.maxHeight}px` }}>
                        <div className="border-b border-black/8 px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-ink/45">
                            {suggestionsLabel}
                        </div>
                        <div ref={suggestionsListRef} className="max-h-56 overflow-auto py-1">
                            {visibleSuggestions.map((suggestion, index) => {
                                const active = index === highlightedIndex;
                                const resolvedValue = suggestion.kind === 'environment' ? resolveEnvironmentValue(variableValues, suggestion.value) : undefined;
                                return (
                                    <div key={`${suggestion.kind}-${suggestion.value}`}>
                                        {index === 0 && hasStaticSuggestions ? <div className="px-3 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-[0.2em] text-ink/35">{suggestionsLabel}</div> : null}
                                        {index === firstEnvironmentSuggestionIndex ? <div className="mx-3 mb-1 mt-2 border-t border-black/12 pt-2 text-[10px] font-semibold uppercase tracking-[0.2em] text-ink/45">Environment Variables</div> : null}
                                        <button
                                            tabIndex={-1}
                                            data-autocomplete-active={active ? 'true' : 'false'}
                                            className={`flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm ${active ? 'bg-[#c7b69a] text-ink' : 'text-ink/75 hover:bg-black/[0.06]'}`}
                                            onMouseDown={(event) => {
                                                event.preventDefault();
                                                commitSuggestion(suggestion);
                                            }}
                                        >
                                            <span className="font-medium">{suggestion.value}</span>
                                            <span className="max-w-[45%] truncate font-mono text-[11px] text-ink/40">{resolvedValue === undefined ? suggestion.detail : stringifyEnvironmentValue(resolvedValue) || '(empty string)'}</span>
                                        </button>
                                    </div>
                                );
                            })}
                        </div>
                        <div className="border-t border-black/8 px-3 py-2 text-[11px] text-ink/45">Use Ctrl+Space to open suggestions manually.</div>
                    </div>,
                    document.body,
                )
                : null}
            {hoverPreview
                ? createPortal(
                    <div
                        className={`pointer-events-none fixed z-[205] max-w-[360px] rounded-xl px-3 py-2 shadow-2xl ${hoverPreview.match.found
                            ? 'border border-black/15 bg-[#e7dac6]'
                            : 'border border-[#8f1d1d]/45 bg-[#f1d1ca] shadow-[0_14px_34px_rgba(143,29,29,0.2)]'
                            }`}
                        style={{ left: `${hoverPreview.left}px`, top: `${hoverPreview.top}px` }}
                    >
                        <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em]">
                            <span className={hoverPreview.match.found ? 'text-ink/45' : 'text-[#8f1d1d]'}>{hoverPreview.match.variableName}</span>
                            {!hoverPreview.match.found ? <span className="rounded-full border border-[#8f1d1d]/35 bg-[#b42318] px-1.5 py-0.5 text-[9px] tracking-[0.16em] text-[#fff7f5]">Missing</span> : null}
                        </div>
                        <div className={`mt-1 whitespace-pre-wrap break-words font-mono text-xs ${hoverPreview.match.found ? 'text-ink/80' : 'text-[#b42318]'}`}>
                            {hoverPreview.match.found ? hoverPreview.match.resolvedValue || '(empty string)' : 'Variable not found in the active environment.'}
                        </div>
                    </div>,
                    document.body,
                )
                : null}
        </div>
    );
}

function KeyValueTable({ title, rows, onChange, variableNames, variableValues, emptyMessage }) {
    const normalizedRows = rows;
    const isHeadersTable = title === 'Headers';

    function updateRow(index, field, value) {
        const nextRows = normalizedRows.map((row, rowIndex) => (rowIndex === index ? { ...row, [field]: value } : row));
        onChange(nextRows);
    }

    function addRow() {
        onChange([...(rows || []), createRow()]);
    }

    function removeRow(index) {
        const nextRows = normalizedRows.filter((_, rowIndex) => rowIndex !== index);
        onChange(nextRows);
    }

    return (
        <div className="flex min-h-[300px] flex-col gap-2.5">
            <div className="flex items-center justify-between">
                <h3 className="text-base font-bold">{title}</h3>
                <button className="ghost-button px-2 py-1.5" onClick={addRow}>
                    Add
                </button>
            </div>
            <div className="grid grid-cols-[72px_minmax(0,1fr)_minmax(0,1fr)_72px] gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-ink/45">
                <span>On</span>
                <span>Key</span>
                <span>Value</span>
                <span></span>
            </div>
            <div className="min-h-0 flex-1 space-y-1.5 overflow-auto pr-1">
                {normalizedRows.length === 0 ? <div className="rounded-xl bg-[#e6d7c1]/78 px-3 py-4 text-sm text-ink/55">{emptyMessage || 'No rows yet.'}</div> : null}
                {normalizedRows.map((row, index) => (
                    <div key={`${title}-${index}`} className="grid grid-cols-[72px_minmax(0,1fr)_minmax(0,1fr)_72px] gap-2">
                        <label className="flex items-center justify-center rounded-xl border border-black/10 bg-[#eadcc5]/88">
                            <input type="checkbox" checked={row.enabled !== false} onChange={(event) => updateRow(index, 'enabled', event.target.checked)} />
                        </label>
                        {isHeadersTable ? (
                            <EnvironmentAutocompleteInput className="field" value={row.key} onChange={(value) => updateRow(index, 'key', value)} spellCheck={false} variableNames={variableNames} variableValues={variableValues} supplementalSuggestions={COMMON_HEADER_KEY_SUGGESTIONS} suggestionsLabel="Header Suggestions" />
                        ) : (
                            <input className="field" value={row.key} onChange={(event) => updateRow(index, 'key', event.target.value)} spellCheck={false} />
                        )}
                        <EnvironmentAutocompleteInput className="field" value={row.value} onChange={(value) => updateRow(index, 'value', value)} variableNames={variableNames} variableValues={variableValues} supplementalSuggestions={isHeadersTable ? (COMMON_HEADER_VALUE_SUGGESTIONS[String(row.key || '').trim().toLowerCase()] || []) : []} suggestionsLabel={isHeadersTable ? 'Header Suggestions' : 'Environment Variables'} />
                        <button className="ghost-button px-2 py-2" onClick={() => removeRow(index)}>
                            Remove
                        </button>
                    </div>
                ))}
            </div>
        </div>
    );
}

function BodyEditor({ request, onChange, onBeautify, variableNames, variableValues }) {
    const bodyModelPath = `inmemory://requests/${request.id}/body.${request.body.type === 'json' ? 'json' : 'txt'}`;
    const multipartFields = request.body.fields || [];

    function addMultipartField() {
        onChange({ ...request.body, fields: [...multipartFields, { key: '', value: '', enabled: true, fieldType: 'text' }] });
    }

    function updateMultipartField(index, updates) {
        onChange({ ...request.body, fields: multipartFields.map((f, i) => (i === index ? { ...f, ...updates } : f)) });
    }

    function removeMultipartField(index) {
        onChange({ ...request.body, fields: multipartFields.filter((_, i) => i !== index) });
    }

    async function pickFileForField(index) {
        const filePath = await requiiIpc.pickFile();
        if (filePath) {
            updateMultipartField(index, { value: filePath });
        }
    }

    return (
        <div className="flex min-h-[300px] flex-col gap-2.5">
            <div className="flex items-center justify-between gap-3">
                <h3 className="text-base font-bold">Body</h3>
                <div className="flex gap-2">
                    <select className="field max-w-[160px] px-2.5 py-1.5" value={request.body.type} onChange={(event) => onChange({ ...request.body, type: event.target.value })}>
                        <option value="none">No Body</option>
                        <option value="json">JSON</option>
                        <option value="text">Text</option>
                        <option value="multipart">Multipart Form</option>
                    </select>
                    {request.body.type === 'multipart' ? (
                        <button className="ghost-button px-2 py-1.5" onClick={addMultipartField} type="button">Add</button>
                    ) : null}
                </div>
            </div>
            {request.body.type === 'none' ? (
                <div className="flex min-h-[280px] items-center justify-center rounded-xl border border-dashed border-black/10 bg-[#e7dac4]/72 text-sm text-ink/55">This request will be sent without a body.</div>
            ) : request.body.type === 'multipart' ? (
                <div className="flex min-h-[280px] flex-col gap-2">
                    <div className="grid grid-cols-[72px_minmax(0,1fr)_110px_minmax(0,1fr)_72px] gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-ink/45">
                        <span>On</span>
                        <span>Key</span>
                        <span>Type</span>
                        <span>Value</span>
                        <span></span>
                    </div>
                    <div className="min-h-0 flex-1 space-y-1.5 overflow-auto pr-1">
                        {multipartFields.length === 0 ? (
                            <div className="rounded-xl bg-[#e6d7c1]/78 px-3 py-4 text-sm text-ink/55">No fields yet. Click Add to get started.</div>
                        ) : null}
                        {multipartFields.map((field, index) => (
                            <div key={index} className="grid grid-cols-[72px_minmax(0,1fr)_110px_minmax(0,1fr)_72px] gap-2">
                                <label className="flex items-center justify-center rounded-xl border border-black/10 bg-[#eadcc5]/88">
                                    <input type="checkbox" checked={field.enabled !== false} onChange={(event) => updateMultipartField(index, { enabled: event.target.checked })} />
                                </label>
                                <input
                                    className="field"
                                    value={field.key || ''}
                                    onChange={(event) => updateMultipartField(index, { key: event.target.value })}
                                    placeholder="name"
                                    spellCheck={false}
                                />
                                <select
                                    className="field px-2.5 py-1.5"
                                    value={field.fieldType || 'text'}
                                    onChange={(event) => updateMultipartField(index, { fieldType: event.target.value, value: '' })}
                                >
                                    <option value="text">Text</option>
                                    <option value="file">File</option>
                                </select>
                                {field.fieldType === 'file' ? (
                                    <div className="flex min-w-0 gap-1">
                                        <input
                                            className="field min-w-0 flex-1 cursor-default truncate"
                                            value={field.value || ''}
                                            readOnly
                                            placeholder="No file selected"
                                        />
                                        <button
                                            className="ghost-button shrink-0 px-2 py-1"
                                            onClick={() => void pickFileForField(index)}
                                            type="button"
                                        >
                                            Browse
                                        </button>
                                    </div>
                                ) : (
                                    <EnvironmentAutocompleteInput
                                        className="field"
                                        value={field.value || ''}
                                        onChange={(value) => updateMultipartField(index, { value })}
                                        variableNames={variableNames}
                                        variableValues={variableValues}
                                        suggestionsLabel="Environment Variables"
                                    />
                                )}
                                <button className="ghost-button px-2 py-2" onClick={() => removeMultipartField(index)} type="button">
                                    Remove
                                </button>
                            </div>
                        ))}
                    </div>
                </div>
            ) : (
                <CodeMiniEditor
                    modelPath={bodyModelPath}
                    value={request.body.content}
                    onChange={(value) => onChange({ ...request.body, content: value })}
                    language={request.body.type === 'json' ? 'json' : 'plaintext'}
                    height={300}
                    placeholder={request.body.type === 'json' ? '{\n  "username": "admin"\n}' : 'Raw request body'}
                    variableNames={variableNames}
                    variableValues={variableValues}
                    headerActions={request.body.type === 'json' ? (
                        <button
                            className="icon-action-button h-6 w-6 border-transparent bg-transparent text-ink/60 hover:bg-black/[0.05]"
                            onClick={onBeautify}
                            title="Beautify request JSON"
                            type="button"
                        >
                            <BeautifyIcon />
                        </button>
                    ) : null}
                />
            )}
        </div>
    );
}

function AuthEditor({ request, onChange, onFetchToken, variableNames, variableValues, accessTokenSectionRef }) {
    const auth = request.auth || { type: 'none', bearerToken: '', username: '', password: '', oauth2: {} };
    const oauth2 = {
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
        ...(auth.oauth2 || {}),
    };
    const labelClassName = 'mb-1 block text-xs font-semibold uppercase tracking-[0.18em] text-ink/45';
    const accessTokenModelPath = `inmemory://requests/${request.id}/auth/oauth2-access-token.txt`;

    function updateOAuth2(updater) {
        const nextOauth2 = typeof updater === 'function' ? updater(oauth2) : updater;
        onChange({ ...auth, type: 'oauth2', oauth2: nextOauth2 });
    }

    return (
        <div className="auth-stack flex min-h-[320px] min-w-0 flex-col gap-0">
            <div>
                <label className={labelClassName}>Auth Type</label>
                <select className="field max-w-[220px]" value={auth.type} onChange={(event) => onChange({ ...auth, type: event.target.value })}>
                    <option value="none">None</option>
                    <option value="basic">Basic</option>
                    <option value="oauth2">OAuth 2.0</option>
                    <option value="bearer">Bearer Token</option>
                </select>
            </div>

            {auth.type === 'bearer' ? (
                <div className="pt-1">
                    <label className={labelClassName}>Token</label>
                    <EnvironmentAutocompleteInput className="field" value={auth.bearerToken || ''} onChange={(value) => onChange({ ...auth, bearerToken: value })} placeholder="{{api_token}}" variableNames={variableNames} variableValues={variableValues} />
                </div>
            ) : null}

            {auth.type === 'basic' ? (
                <div className="auth-grid grid min-w-0 gap-x-3 gap-y-1 pt-1 lg:grid-cols-2">
                    <div>
                        <label className={labelClassName}>Username</label>
                        <EnvironmentAutocompleteInput className="field" value={auth.username || ''} onChange={(value) => onChange({ ...auth, username: value })} variableNames={variableNames} variableValues={variableValues} />
                    </div>
                    <div>
                        <label className={labelClassName}>Password</label>
                        <EnvironmentAutocompleteInput className="field" value={auth.password || ''} onChange={(value) => onChange({ ...auth, password: value })} variableNames={variableNames} variableValues={variableValues} />
                    </div>
                </div>
            ) : null}

            {auth.type === 'oauth2' ? (
                <div className="auth-stack space-y-0 pt-1">
                    <div className="auth-grid grid min-w-0 gap-x-3 gap-y-1 lg:grid-cols-2">
                        <div>
                            <label className={labelClassName}>Grant Type</label>
                            <select className="field" value={oauth2.grantType} onChange={(event) => updateOAuth2({ ...oauth2, grantType: event.target.value })}>
                                <option value="client_credentials">Client Credentials</option>
                                <option value="password">Resource Owner Password Credentials</option>
                                <option value="authorization_code">Authorization Code</option>
                            </select>
                        </div>
                        <div>
                            <label className={labelClassName}>Client Authentication</label>
                            <select className="field" value={oauth2.clientAuthentication} onChange={(event) => updateOAuth2({ ...oauth2, clientAuthentication: event.target.value })}>
                                <option value="basic">Basic Auth Header</option>
                                <option value="body">Request Body</option>
                            </select>
                        </div>
                    </div>

                    <div className="auth-grid grid min-w-0 gap-x-3 gap-y-1 lg:grid-cols-2">
                        <div>
                            <label className={labelClassName}>Access Token URL</label>
                            <EnvironmentAutocompleteInput className="field" value={oauth2.accessTokenUrl} onChange={(value) => updateOAuth2({ ...oauth2, accessTokenUrl: value })} variableNames={variableNames} variableValues={variableValues} />
                        </div>
                        <div>
                            <label className={labelClassName}>Authorization URL</label>
                            <EnvironmentAutocompleteInput className="field" value={oauth2.authorizationUrl} onChange={(value) => updateOAuth2({ ...oauth2, authorizationUrl: value })} variableNames={variableNames} variableValues={variableValues} />
                        </div>
                    </div>

                    <div className="auth-grid grid min-w-0 gap-x-3 gap-y-1 lg:grid-cols-2">
                        <div>
                            <label className={labelClassName}>Client ID</label>
                            <EnvironmentAutocompleteInput className="field" value={oauth2.clientId} onChange={(value) => updateOAuth2({ ...oauth2, clientId: value })} variableNames={variableNames} variableValues={variableValues} />
                        </div>
                        <div>
                            <label className={labelClassName}>Client Secret</label>
                            <EnvironmentAutocompleteInput className="field" value={oauth2.clientSecret} onChange={(value) => updateOAuth2({ ...oauth2, clientSecret: value })} variableNames={variableNames} variableValues={variableValues} />
                        </div>
                    </div>

                    <div className="auth-grid grid min-w-0 gap-x-3 gap-y-1 lg:grid-cols-2">
                        <div>
                            <label className={labelClassName}>Scope</label>
                            <EnvironmentAutocompleteInput className="field" value={oauth2.scope} onChange={(value) => updateOAuth2({ ...oauth2, scope: value })} variableNames={variableNames} variableValues={variableValues} />
                        </div>
                        <div>
                            <label className={labelClassName}>Audience / Resource</label>
                            <EnvironmentAutocompleteInput className="field" value={oauth2.audience || oauth2.resource || ''} onChange={(value) => updateOAuth2({ ...oauth2, audience: value, resource: value })} variableNames={variableNames} variableValues={variableValues} />
                        </div>
                    </div>

                    {oauth2.grantType === 'password' ? (
                        <div className="auth-grid grid min-w-0 gap-x-3 gap-y-1 lg:grid-cols-2">
                            <div>
                                <label className={labelClassName}>Username</label>
                                <EnvironmentAutocompleteInput className="field" value={oauth2.username} onChange={(value) => updateOAuth2({ ...oauth2, username: value })} variableNames={variableNames} variableValues={variableValues} />
                            </div>
                            <div>
                                <label className={labelClassName}>Password</label>
                                <EnvironmentAutocompleteInput className="field" value={oauth2.password} onChange={(value) => updateOAuth2({ ...oauth2, password: value })} variableNames={variableNames} variableValues={variableValues} />
                            </div>
                        </div>
                    ) : null}

                    {oauth2.grantType === 'authorization_code' ? (
                        <div className="auth-grid grid min-w-0 gap-x-3 gap-y-1 lg:grid-cols-2">
                            <div>
                                <label className={labelClassName}>Authorization Code</label>
                                <EnvironmentAutocompleteInput className="field" value={oauth2.authorizationCode} onChange={(value) => updateOAuth2({ ...oauth2, authorizationCode: value })} variableNames={variableNames} variableValues={variableValues} />
                            </div>
                            <div>
                                <label className={labelClassName}>Redirect URI</label>
                                <EnvironmentAutocompleteInput className="field" value={oauth2.redirectUri} onChange={(value) => updateOAuth2({ ...oauth2, redirectUri: value })} variableNames={variableNames} variableValues={variableValues} />
                            </div>
                        </div>
                    ) : null}

                    <div className="auth-grid grid min-w-0 gap-x-3 gap-y-1 lg:grid-cols-3">
                        <div>
                            <label className={labelClassName}>Add Token To</label>
                            <select className="field" value={oauth2.addTokenTo} onChange={(event) => updateOAuth2({ ...oauth2, addTokenTo: event.target.value, tokenParameterName: event.target.value === 'query' ? 'access_token' : 'Authorization' })}>
                                <option value="request_header">Request Header</option>
                                <option value="query">Query Param</option>
                            </select>
                        </div>
                        <div>
                            <label className={labelClassName}>Field Name</label>
                            <EnvironmentAutocompleteInput className="field" value={oauth2.tokenParameterName} onChange={(value) => updateOAuth2({ ...oauth2, tokenParameterName: value })} variableNames={variableNames} variableValues={variableValues} />
                        </div>
                        <div>
                            <label className={labelClassName}>Token Prefix</label>
                            <EnvironmentAutocompleteInput className="field" value={oauth2.tokenPrefix} onChange={(value) => updateOAuth2({ ...oauth2, tokenPrefix: value })} variableNames={variableNames} variableValues={variableValues} />
                        </div>
                    </div>

                    <div ref={accessTokenSectionRef} className="min-w-0 rounded-2xl border border-black/8 bg-[#e3d1b5]/74 p-3">
                        <div className="flex items-center justify-between gap-3">
                            <div>
                                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-ink/45">Access Token</p>
                                <p className="text-sm text-ink/55">Use Fetch Token for supported grant types, or paste a token manually.</p>
                            </div>
                            <div className="flex gap-2">
                                <button className="ghost-button px-2 py-1.5" onClick={() => onFetchToken(oauth2)}>Fetch Token</button>
                                <button className="ghost-button px-2 py-1.5" onClick={() => updateOAuth2({ ...oauth2, accessToken: '' })}>Clear</button>
                            </div>
                        </div>
                        <div className="mt-2">
                            <CodeMiniEditor modelPath={accessTokenModelPath} value={oauth2.accessToken} onChange={(value) => updateOAuth2({ ...oauth2, accessToken: value })} language="plaintext" height={72} placeholder="Paste or fetch an access token" variableNames={variableNames} variableValues={variableValues} />
                        </div>
                    </div>
                </div>
            ) : null}
        </div>
    );
}

function EnvironmentPanel({ environments, baseEnvironment, onChange, onAddEnvironment, activeEnvironment, onRenameVariableUsages }) {
    const [editingEnvironmentId, setEditingEnvironmentId] = useState(null);
    const [draftEnvironmentName, setDraftEnvironmentName] = useState('');
    const [draggedEnvironmentId, setDraggedEnvironmentId] = useState(null);
    const [dropTarget, setDropTarget] = useState(null);
    const [selectedEnvironmentId, setSelectedEnvironmentId] = useState(activeEnvironment?.id || baseEnvironment?.id || null);
    const selectedEnvironment = useMemo(() => {
        if (selectedEnvironmentId === baseEnvironment?.id) {
            return baseEnvironment || null;
        }

        return environments.environments.find((environment) => environment.id === selectedEnvironmentId) || activeEnvironment || baseEnvironment || null;
    }, [activeEnvironment, baseEnvironment, environments.environments, selectedEnvironmentId]);
    const isEditingBaseEnvironment = selectedEnvironment?.id === baseEnvironment?.id;
    const savedEnvironmentJson = useMemo(() => JSON.stringify(selectedEnvironment?.variables || {}, null, 2), [selectedEnvironment?.variables]);
    const [environmentDraft, setEnvironmentDraft] = useState(savedEnvironmentJson);
    const [environmentError, setEnvironmentError] = useState('');
    const [isExpandedEditorOpen, setIsExpandedEditorOpen] = useState(false);
    const lastSyncedEnvironmentIdRef = useRef(selectedEnvironment?.id || null);
    const lastSyncedEnvironmentJsonRef = useRef(savedEnvironmentJson);

    useEffect(() => {
        const selectedStillExists = selectedEnvironmentId === baseEnvironment?.id || environments.environments.some((environment) => environment.id === selectedEnvironmentId);
        if (!selectedStillExists) {
            setSelectedEnvironmentId(activeEnvironment?.id || baseEnvironment?.id || null);
        }
    }, [activeEnvironment?.id, baseEnvironment?.id, environments.environments, selectedEnvironmentId]);

    useEffect(() => {
        const nextSelectedEnvironmentId = selectedEnvironment?.id || null;
        const environmentChanged = lastSyncedEnvironmentIdRef.current !== nextSelectedEnvironmentId;
        const draftMatchesLastSynced = environmentDraft === lastSyncedEnvironmentJsonRef.current;

        if (environmentChanged || draftMatchesLastSynced) {
            setEnvironmentDraft(savedEnvironmentJson);
            setEnvironmentError('');
        }

        lastSyncedEnvironmentIdRef.current = nextSelectedEnvironmentId;
        lastSyncedEnvironmentJsonRef.current = savedEnvironmentJson;
    }, [environmentDraft, savedEnvironmentJson, selectedEnvironment?.id]);

    const editorRawVariableValues = useMemo(() => {
        const trimmedDraft = environmentDraft.trim();
        if (!trimmedDraft) {
            return {};
        }

        try {
            const parsed = JSON.parse(environmentDraft);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                return parsed;
            }
        } catch {
            return selectedEnvironment?.variables || {};
        }

        return selectedEnvironment?.variables || {};
    }, [environmentDraft, selectedEnvironment?.variables]);
    const editorVariableValues = useMemo(
        () => (isEditingBaseEnvironment
            ? { _BASE_ENV: editorRawVariableValues }
            : { ...(editorRawVariableValues || {}), _BASE_ENV: baseEnvironment?.variables || {} }),
        [baseEnvironment?.variables, editorRawVariableValues, isEditingBaseEnvironment],
    );
    const editorVariableNames = useMemo(() => listEnvironmentVariableNames(editorVariableValues), [editorVariableValues]);

    function findEmptyEnvironmentKey(currentValue, currentPath = '') {
        if (Array.isArray(currentValue)) {
            for (let index = 0; index < currentValue.length; index += 1) {
                const nextPath = currentPath ? `${currentPath}.${index}` : String(index);
                const foundPath = findEmptyEnvironmentKey(currentValue[index], nextPath);
                if (foundPath) {
                    return foundPath;
                }
            }

            return null;
        }

        if (!currentValue || typeof currentValue !== 'object') {
            return null;
        }

        for (const [key, value] of Object.entries(currentValue)) {
            const nextPath = currentPath ? `${currentPath}.${key}` : key;
            if (!String(key).trim()) {
                return currentPath ? `${currentPath}.<empty>` : '<empty>';
            }

            const foundPath = findEmptyEnvironmentKey(value, nextPath);
            if (foundPath) {
                return foundPath;
            }
        }

        return null;
    }

    function findEnvironmentKeyWithWhitespace(currentValue, currentPath = '') {
        if (Array.isArray(currentValue)) {
            for (let index = 0; index < currentValue.length; index += 1) {
                const nextPath = currentPath ? `${currentPath}.${index}` : String(index);
                const foundPath = findEnvironmentKeyWithWhitespace(currentValue[index], nextPath);
                if (foundPath) {
                    return foundPath;
                }
            }

            return null;
        }

        if (!currentValue || typeof currentValue !== 'object') {
            return null;
        }

        for (const [key, value] of Object.entries(currentValue)) {
            const nextPath = currentPath ? `${currentPath}.${key}` : key;
            if (/\s/.test(key)) {
                return nextPath;
            }

            const foundPath = findEnvironmentKeyWithWhitespace(value, nextPath);
            if (foundPath) {
                return foundPath;
            }
        }

        return null;
    }

    function parseEnvironmentDraft(input = environmentDraft) {
        const trimmedInput = input.trim();
        if (!trimmedInput) {
            return { ok: true, value: {} };
        }

        try {
            const parsed = JSON.parse(input);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                return {
                    ok: false,
                    error: 'Environment JSON must use an object at the root.',
                };
            }

            const emptyKeyPath = findEmptyEnvironmentKey(parsed);
            if (emptyKeyPath) {
                return {
                    ok: false,
                    error: `Environment variable keys cannot be empty: ${emptyKeyPath}`,
                };
            }

            const keyWithWhitespace = findEnvironmentKeyWithWhitespace(parsed);
            if (keyWithWhitespace) {
                return {
                    ok: false,
                    error: `Environment variable keys cannot contain spaces: ${keyWithWhitespace}`,
                };
            }

            return { ok: true, value: parsed };
        } catch (error) {
            return {
                ok: false,
                error: error.message || 'Environment JSON is invalid.',
            };
        }
    }

    function handleEnvironmentDraftChange(nextValue) {
        setEnvironmentDraft(nextValue);
        const result = parseEnvironmentDraft(nextValue);
        setEnvironmentError(result.ok ? '' : result.error);

        if (!result.ok) {
            return;
        }

        onChange((previous) => {
            if (selectedEnvironment?.id === previous.base_environment?.id) {
                return {
                    ...previous,
                    base_environment: {
                        ...previous.base_environment,
                        variables: result.value,
                    },
                };
            }

            return {
                ...previous,
                environments: previous.environments.map((environment) => (environment.id === selectedEnvironment?.id ? { ...environment, variables: result.value } : environment)),
            };
        });
    }

    function formatEnvironmentJson() {
        const result = parseEnvironmentDraft();
        if (!result.ok) {
            setEnvironmentError(result.error);
            return;
        }

        setEnvironmentDraft(JSON.stringify(result.value, null, 2));
        setEnvironmentError('');
    }

    function setActiveEnvironment(id) {
        onChange((previous) => ({
            ...previous,
            active_environment_id: id,
        }));
    }

    function updateActiveEnvironment(updater) {
        onChange((previous) => ({
            ...previous,
            environments: previous.environments.map((environment) => (environment.id === previous.active_environment_id ? updater(environment) : environment)),
        }));
    }

    function removeEnvironment(environmentId) {
        onChange((previous) => {
            if (previous.environments.length === 1) {
                return previous;
            }

            const target = previous.environments.find((environment) => environment.id === environmentId);
            if (!target) {
                return previous;
            }

            const confirmed = window.confirm(`Delete this environment?\n\n${target.name}\n\nIts variables will be permanently removed.`);
            if (!confirmed) {
                return previous;
            }

            const nextEnvironments = previous.environments.filter((environment) => environment.id !== environmentId);
            const nextActiveEnvironmentId = previous.active_environment_id === environmentId ? nextEnvironments[0]?.id || previous.active_environment_id : previous.active_environment_id;

            return {
                active_environment_id: nextActiveEnvironmentId,
                environments: nextEnvironments,
            };
        });
    }

    function startEditingEnvironment(environment) {
        setEditingEnvironmentId(environment.id);
        setDraftEnvironmentName(environment.name);
    }

    function saveEnvironmentName(environmentId) {
        const trimmed = draftEnvironmentName.trim();
        if (!trimmed) {
            return;
        }

        onChange((previous) => ({
            ...previous,
            environments: previous.environments.map((environment) => (environment.id === environmentId ? { ...environment, name: trimmed } : environment)),
        }));
        setEditingEnvironmentId(null);
        setDraftEnvironmentName('');
    }

    function cancelEnvironmentEditing() {
        setEditingEnvironmentId(null);
        setDraftEnvironmentName('');
    }

    function moveEnvironment(environmentId, targetEnvironmentId, position) {
        onChange((previous) => {
            const sourceIndex = previous.environments.findIndex((environment) => environment.id === environmentId);
            const targetIndex = previous.environments.findIndex((environment) => environment.id === targetEnvironmentId);
            if (sourceIndex === -1 || targetIndex === -1 || sourceIndex === targetIndex) {
                return previous;
            }

            const nextEnvironments = [...previous.environments];
            const [movedEnvironment] = nextEnvironments.splice(sourceIndex, 1);
            const adjustedTargetIndex = sourceIndex < targetIndex ? targetIndex - 1 : targetIndex;
            const insertIndex = position === 'after' ? adjustedTargetIndex + 1 : adjustedTargetIndex;

            nextEnvironments.splice(insertIndex, 0, movedEnvironment);

            return {
                ...previous,
                environments: nextEnvironments,
            };
        });
    }

    function handleEnvironmentDragStart(environmentId) {
        setDraggedEnvironmentId(environmentId);
        setDropTarget(null);
    }

    function handleEnvironmentDragOver(event, environmentId) {
        if (!draggedEnvironmentId || draggedEnvironmentId === environmentId) {
            return;
        }

        event.preventDefault();
        const bounds = event.currentTarget.getBoundingClientRect();
        const midpoint = bounds.top + bounds.height / 2;
        const position = event.clientY < midpoint ? 'before' : 'after';
        setDropTarget({ environmentId, position });
    }

    function handleEnvironmentDrop(environmentId) {
        if (!draggedEnvironmentId || draggedEnvironmentId === environmentId || !dropTarget) {
            clearEnvironmentDragState();
            return;
        }

        moveEnvironment(draggedEnvironmentId, environmentId, dropTarget.position);
        clearEnvironmentDragState();
    }

    function clearEnvironmentDragState() {
        setDraggedEnvironmentId(null);
        setDropTarget(null);
    }

    return (
        <>
            <div className="border-b border-black/8 px-4 py-3">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-ink/45">Environments</p>
                <p className="mt-1 text-xs leading-5 text-ink/60">A workspace has one base environment plus runtime environments. Base values are referenced with `_BASE_ENV`.</p>
                <div className="mt-2.5">
                    <button
                        className={`relative z-[2] flex w-full items-center gap-2 rounded-xl border px-3 py-2 text-left transition ${selectedEnvironment?.id === baseEnvironment?.id ? 'border-ink bg-[#e7d3b0] text-ink shadow-[0_1px_0_rgba(255,248,232,0.4)]' : 'border-black/10 bg-[#eadcc5]/88 text-ink/78 hover:bg-[#efe2cc]'}`}
                        onClick={() => setSelectedEnvironmentId(baseEnvironment?.id || null)}
                        type="button"
                    >
                        <span className="truncate text-sm font-medium">{baseEnvironment?.name || 'Base Environment'}</span>
                    </button>
                    <div className="relative z-[1] -mt-0.5 ml-4 border-l border-black/8 pl-2.5 pt-1.5">
                        <ScrollSliderList label="Browse environments" maxHeight={188} contentClassName="space-y-1.5">
                            {environments.environments.map((environment) => {
                                const active = environment.id === environments.active_environment_id;
                                const selected = environment.id === selectedEnvironment?.id;
                                const isEditing = editingEnvironmentId === environment.id;
                                const isDropBefore = dropTarget?.environmentId === environment.id && dropTarget.position === 'before';
                                const isDropAfter = dropTarget?.environmentId === environment.id && dropTarget.position === 'after';
                                return (
                                    <div
                                        key={environment.id}
                                        className={`cursor-pointer rounded-[18px] border px-3 py-2 transition ${active ? 'text-ink' : 'text-ink/78'} ${selected ? 'border-ink bg-[#ead8b8] shadow-[0_1px_0_rgba(255,248,232,0.3)]' : 'border-black/10 bg-[#dfc9a6]/88 hover:bg-[#e7d4b3]'} ${draggedEnvironmentId === environment.id ? 'opacity-60' : ''} ${isDropBefore ? 'border-t-4 border-t-ink' : ''} ${isDropAfter ? 'border-b-4 border-b-ink' : ''}`}
                                        onDragOver={(event) => handleEnvironmentDragOver(event, environment.id)}
                                        onDrop={() => handleEnvironmentDrop(environment.id)}
                                        onDragEnd={clearEnvironmentDragState}
                                        onClick={(event) => {
                                            if (isEditing || isNestedInteractiveElement(event.target)) {
                                                return;
                                            }

                                            setSelectedEnvironmentId(environment.id);
                                            setActiveEnvironment(environment.id);
                                        }}
                                    >
                                        <div className="flex items-center gap-2">
                                            {isEditing ? (
                                                <div className="flex min-w-0 flex-1 items-center gap-2 text-left">
                                                    <span className={`inline-block h-2.5 w-2.5 rounded-full ${active ? 'bg-[#14a44d] shadow-[0_0_0_2px_rgba(20,164,77,0.18)]' : 'bg-black/15'}`}></span>
                                                    <input
                                                        autoFocus
                                                        className="w-full rounded-lg bg-transparent text-sm font-medium outline-none"
                                                        value={draftEnvironmentName}
                                                        spellCheck={false}
                                                        onChange={(event) => setDraftEnvironmentName(event.target.value)}
                                                        onBlur={() => saveEnvironmentName(environment.id)}
                                                        onKeyDown={(event) => {
                                                            if (event.key === 'Enter') {
                                                                event.preventDefault();
                                                                saveEnvironmentName(environment.id);
                                                            }
                                                            if (event.key === 'Escape') {
                                                                event.preventDefault();
                                                                cancelEnvironmentEditing();
                                                            }
                                                        }}
                                                    />
                                                </div>
                                            ) : (
                                                <button className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => {
                                                    setSelectedEnvironmentId(environment.id);
                                                    setActiveEnvironment(environment.id);
                                                }} type="button">
                                                    <span className={`inline-block h-2.5 w-2.5 rounded-full ${active ? 'bg-[#14a44d] shadow-[0_0_0_2px_rgba(20,164,77,0.18)]' : 'bg-black/15'}`}></span>
                                                    <span className="truncate text-sm font-medium">{environment.name}</span>
                                                </button>
                                            )}
                                            <div className="flex items-center gap-1">
                                                <button
                                                    className="icon-action-button cursor-grab active:cursor-grabbing"
                                                    title="Drag to reorder"
                                                    draggable={!isEditing}
                                                    onDragStart={() => handleEnvironmentDragStart(environment.id)}
                                                    onDragEnd={clearEnvironmentDragState}
                                                    disabled={isEditing}
                                                    type="button"
                                                >
                                                    <DragHandleIcon />
                                                </button>
                                                <button className="icon-action-button" onClick={() => startEditingEnvironment(environment)} title="Rename environment" disabled={isEditing} type="button">
                                                    <PencilIcon />
                                                </button>
                                                <button className="icon-action-button" onClick={() => removeEnvironment(environment.id)} title="Delete environment" disabled={environments.environments.length <= 1 || isEditing} type="button">
                                                    <TrashIcon />
                                                </button>
                                            </div>
                                        </div>
                                    </div>
                                );
                            })}
                        </ScrollSliderList>
                    </div>
                </div>
                <button className="ghost-button mt-2.5 inline-flex w-full items-center justify-center gap-2 py-2" onClick={onAddEnvironment}>
                    <NewWorkspaceIcon />
                    Add Environment
                </button>
            </div>

            <div className="min-h-0 flex-1 overflow-auto px-4 py-4">
                <div className="mb-3">
                    <div className="flex items-center gap-2">
                        <h3 className="text-sm font-bold uppercase tracking-[0.22em] text-ink/45">{isEditingBaseEnvironment ? 'Base Environment Variables' : 'Environment Variables'}</h3>
                        <span
                            className={environmentError ? 'text-[#8f1d1d]' : 'text-[#2f6f43]'}
                            title={environmentError || 'Valid JSON'}
                            aria-label={environmentError || 'Valid JSON'}
                        >
                            {environmentError ? <InvalidStatusIcon /> : <ValidStatusIcon />}
                        </span>
                    </div>
                    <p className="mt-1 text-xs text-ink/55">{isEditingBaseEnvironment ? 'Base variables are available to requests and environments via `_BASE_ENV`.' : `Editing ${selectedEnvironment?.name || 'Environment'}. Base values remain available via _BASE_ENV.`}</p>
                </div>

                <div className="rounded-2xl border border-black/10 bg-[#e3d1b5]/72 p-3">
                    <CodeMiniEditor
                        modelPath={`inmemory://environments/${selectedEnvironment?.id || 'unknown'}/panel.json`}
                        value={environmentDraft}
                        onChange={handleEnvironmentDraftChange}
                        language="json"
                        height={420}
                        placeholder={'{\n  "base_url": "https://api.example.com",\n  "auth": {\n    "client_secret": "..."\n  }\n}'}
                        variableNames={editorVariableNames}
                        variableValues={editorVariableValues}
                        headerActions={
                            <>
                                <button
                                    className="icon-action-button h-6 w-6 border-transparent bg-transparent text-ink/60 hover:bg-black/[0.05]"
                                    onClick={formatEnvironmentJson}
                                    title="Beautify environment JSON"
                                    type="button"
                                >
                                    <BeautifyIcon />
                                </button>
                                <button
                                    className="icon-action-button h-6 w-6 border-transparent bg-transparent text-ink/60 hover:bg-black/[0.05]"
                                    onClick={() => setIsExpandedEditorOpen(true)}
                                    title="Open expanded environment editor"
                                    type="button"
                                >
                                    <ExpandIcon />
                                </button>
                            </>
                        }
                    />
                    {environmentError ? <p className="mt-3 text-sm text-[#8f1d1d]">{environmentError}</p> : null}
                </div>
            </div>
            {isExpandedEditorOpen ? (
                <EnvironmentEditorDialog
                    value={environmentDraft}
                    onChange={handleEnvironmentDraftChange}
                    onBeautify={formatEnvironmentJson}
                    onClose={() => setIsExpandedEditorOpen(false)}
                    variableNames={editorVariableNames}
                    variableValues={editorVariableValues}
                    error={environmentError}
                />
            ) : null}
        </>
    );
}

export default App;