import { BASE_ENVIRONMENT_ID, BASE_ENVIRONMENT_NAME, BASE_ENVIRONMENT_PREFIX, EMPTY_ENVIRONMENTS, ENV_AUTOCOMPLETE_MIN_LENGTH } from '../constants';

function isPlainObject(value) {
    return Boolean(value) && Object.prototype.toString.call(value) === '[object Object]';
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

export function normalizeEnvironmentsState(environmentsState = EMPTY_ENVIRONMENTS) {
    const fallbackState = EMPTY_ENVIRONMENTS;
    const baseEnvironment = normalizeEnvironmentEntry(
        environmentsState?.base_environment,
        fallbackState.base_environment.id,
        fallbackState.base_environment.name,
    );

    const seenIds = new Set([baseEnvironment.id]);
    const normalizedEnvironments = (Array.isArray(environmentsState?.environments) ? environmentsState.environments : [])
        .map((environment, index) => normalizeEnvironmentEntry(environment, index === 0 ? 'env_default' : `env_${index + 1}`, environment?.name || `Environment ${index + 1}`))
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

export function getBaseEnvironment(environmentsState = EMPTY_ENVIRONMENTS) {
    return normalizeEnvironmentsState(environmentsState).base_environment;
}

export function getActiveEnvironment(environmentsState = EMPTY_ENVIRONMENTS, activeEnvironmentId = '') {
    const normalizedState = normalizeEnvironmentsState(environmentsState);
    return normalizedState.environments.find((environment) => environment.id === (activeEnvironmentId || normalizedState.active_environment_id)) || normalizedState.environments[0] || null;
}

export function buildEnvironmentVariableValues(environmentsState = EMPTY_ENVIRONMENTS, activeEnvironmentId = '') {
    const normalizedState = normalizeEnvironmentsState(environmentsState);
    const activeEnvironment = getActiveEnvironment(normalizedState, activeEnvironmentId);

    return {
        ...(isPlainObject(activeEnvironment?.variables) ? activeEnvironment.variables : {}),
        [BASE_ENVIRONMENT_PREFIX]: isPlainObject(normalizedState.base_environment?.variables) ? normalizedState.base_environment.variables : {},
    };
}

function normalizeEnvironmentPath(path) {
    return String(path || '')
        .split('.')
        .map((segment) => segment.trim())
        .filter(Boolean);
}

export function resolveEnvironmentValue(variableValues = {}, variableName = '') {
    const pathSegments = normalizeEnvironmentPath(variableName);
    if (pathSegments.length === 0) {
        return undefined;
    }

    let currentValue = variableValues;
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

export function stringifyEnvironmentValue(value) {
    if (value === undefined || value === null) {
        return '';
    }

    if (typeof value === 'string') {
        return value;
    }

    return JSON.stringify(value);
}

export function listEnvironmentVariableNames(variableValues = {}) {
    const names = [];

    function visit(currentValue, currentPath = '') {
        if (Array.isArray(currentValue)) {
            if (currentPath) {
                names.push(currentPath);
            }
            currentValue.forEach((entry, index) => {
                const nextPath = currentPath ? `${currentPath}.${index}` : String(index);
                if (isPlainObject(entry) || Array.isArray(entry)) {
                    visit(entry, nextPath);
                    return;
                }
                names.push(nextPath);
            });
            return;
        }

        if (!isPlainObject(currentValue)) {
            if (currentPath) {
                names.push(currentPath);
            }
            return;
        }

        for (const [key, value] of Object.entries(currentValue)) {
            const nextPath = currentPath ? `${currentPath}.${key}` : key;
            if (isPlainObject(value) || Array.isArray(value)) {
                names.push(nextPath);
                visit(value, nextPath);
                continue;
            }
            names.push(nextPath);
        }
    }

    visit(variableValues);
    return [...new Set(names)].sort((left, right) => left.localeCompare(right));
}

export function listEnvironmentVariableEntries(variableValues = {}) {
    return listEnvironmentVariableNames(variableValues).map((name) => [name, stringifyEnvironmentValue(resolveEnvironmentValue(variableValues, name))]);
}

export function setEnvironmentValueAtPath(variableValues = {}, variableName = '', nextValue = '') {
    const pathSegments = normalizeEnvironmentPath(variableName);
    if (pathSegments.length === 0) {
        return isPlainObject(variableValues) ? variableValues : {};
    }

    function setValue(currentValue, depth) {
        const key = pathSegments[depth];
        const baseObject = isPlainObject(currentValue) ? { ...currentValue } : {};

        if (depth === pathSegments.length - 1) {
            baseObject[key] = nextValue;
            return baseObject;
        }

        baseObject[key] = setValue(baseObject[key], depth + 1);
        return baseObject;
    }

    return setValue(variableValues, 0);
}

export function removeEnvironmentValueAtPath(variableValues = {}, variableName = '') {
    const pathSegments = normalizeEnvironmentPath(variableName);
    if (pathSegments.length === 0 || !isPlainObject(variableValues)) {
        return isPlainObject(variableValues) ? variableValues : {};
    }

    function removeValue(currentValue, depth) {
        if (!isPlainObject(currentValue)) {
            return currentValue;
        }

        const key = pathSegments[depth];
        if (!Object.prototype.hasOwnProperty.call(currentValue, key)) {
            return currentValue;
        }

        const baseObject = { ...currentValue };
        if (depth === pathSegments.length - 1) {
            delete baseObject[key];
            return baseObject;
        }

        const nextChild = removeValue(baseObject[key], depth + 1);
        if (isPlainObject(nextChild) && Object.keys(nextChild).length === 0) {
            delete baseObject[key];
        } else {
            baseObject[key] = nextChild;
        }
        return baseObject;
    }

    return removeValue(variableValues, 0);
}

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function getEnvironmentInterpolationMatches(value, variableValues = {}) {
    const safeValue = value || '';
    const matches = [];
    const pattern = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;
    let match;

    while ((match = pattern.exec(safeValue)) !== null) {
        const variableName = match[1];
        const resolvedValue = resolveEnvironmentValue(variableValues, variableName);
        const found = resolvedValue !== undefined;

        matches.push({
            start: match.index,
            end: pattern.lastIndex,
            raw: match[0],
            variableName,
            found,
            resolvedValue: found ? stringifyEnvironmentValue(resolvedValue) : '',
        });
    }

    return matches;
}

export function getEnvironmentAutocompleteContext(value, cursorPosition, forceOpen = false) {
    const safeValue = value || '';
    const safeCursorPosition = typeof cursorPosition === 'number' ? cursorPosition : safeValue.length;
    const beforeCursor = safeValue.slice(0, safeCursorPosition);
    const interpolationStart = beforeCursor.lastIndexOf('{{');

    if (interpolationStart !== -1) {
        const interpolationEnd = safeValue.indexOf('}}', interpolationStart + 2);
        const replaceEnd = interpolationEnd === -1 ? safeValue.length : interpolationEnd;
        const cursorInsideInterpolation = safeCursorPosition >= interpolationStart + 2 && safeCursorPosition <= replaceEnd;

        if (cursorInsideInterpolation) {
            const interpolationValue = safeValue.slice(interpolationStart + 2, replaceEnd);
            const isValidInterpolation = /^\s*[A-Za-z0-9_.-]*\s*$/.test(interpolationValue) && !interpolationValue.includes('{{');
            const query = interpolationValue.trim();

            if (isValidInterpolation && (forceOpen || query.length >= ENV_AUTOCOMPLETE_MIN_LENGTH)) {
                return {
                    query,
                    replaceStart: interpolationStart + 2,
                    replaceEnd,
                    mode: 'inside-braces',
                };
            }
        }
    }

    const tokenMatch = beforeCursor.match(/[A-Za-z0-9_.-]*$/);
    const query = tokenMatch?.[0] || '';

    if (!forceOpen && query.length < ENV_AUTOCOMPLETE_MIN_LENGTH) {
        return null;
    }

    return {
        query,
        replaceStart: safeCursorPosition - query.length,
        replaceEnd: safeCursorPosition,
        mode: 'wrap',
    };
}

export function getEnvironmentSuggestions(variableNames, query) {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) {
        return [...variableNames].sort((left, right) => left.localeCompare(right));
    }

    return [...variableNames]
        .filter((name) => name.toLowerCase().includes(normalizedQuery))
        .sort((left, right) => {
            const leftStarts = left.toLowerCase().startsWith(normalizedQuery);
            const rightStarts = right.toLowerCase().startsWith(normalizedQuery);
            if (leftStarts !== rightStarts) {
                return leftStarts ? -1 : 1;
            }
            return left.localeCompare(right);
        });
}

export function renameEnvironmentVariableReferencesInString(value, oldKey, newKey) {
    const safeValue = typeof value === 'string' ? value : String(value || '');
    if (!safeValue || !oldKey || !newKey || oldKey === newKey) {
        return safeValue;
    }

    const pattern = new RegExp(`\\{\\{(\\s*)${escapeRegExp(oldKey)}(\\s*)\\}\\}`, 'g');
    return safeValue.replace(pattern, (_, leadingWhitespace, trailingWhitespace) => `{{${leadingWhitespace}${newKey}${trailingWhitespace}}}`);
}

export function renameEnvironmentVariableReferencesInRequest(request, oldKey, newKey) {
    if (!request || !oldKey || !newKey || oldKey === newKey) {
        return request;
    }

    let changed = false;

    function renameText(value) {
        const nextValue = renameEnvironmentVariableReferencesInString(value, oldKey, newKey);
        if (nextValue !== value) {
            changed = true;
        }
        return nextValue;
    }

    function renameRows(rows = []) {
        return rows.map((row) => {
            const nextKey = renameText(row.key || '');
            const nextValue = renameText(row.value || '');
            if (nextKey === (row.key || '') && nextValue === (row.value || '')) {
                return row;
            }

            return {
                ...row,
                key: nextKey,
                value: nextValue,
            };
        });
    }

    const nextRequest = {
        ...request,
        url: renameText(request.url || ''),
        headers: renameRows(request.headers || []),
        query_params: renameRows(request.query_params || []),
        body: request.body
            ? {
                ...request.body,
                content: renameText(request.body.content || ''),
            }
            : request.body,
        auth: request.auth
            ? {
                ...request.auth,
                bearerToken: renameText(request.auth.bearerToken || ''),
                username: renameText(request.auth.username || ''),
                password: renameText(request.auth.password || ''),
            }
            : request.auth,
    };

    return changed ? nextRequest : request;
}

export function renameEnvironmentVariableReferencesInEnvironments(environmentsState, oldKey, newKey) {
    if (!environmentsState || !oldKey || !newKey || oldKey === newKey) {
        return environmentsState;
    }

    function renameWithinValue(value) {
        if (typeof value === 'string') {
            return renameEnvironmentVariableReferencesInString(value, oldKey, newKey);
        }

        if (Array.isArray(value)) {
            let arrayChanged = false;
            const nextArray = value.map((entry) => {
                const nextEntry = renameWithinValue(entry);
                if (nextEntry !== entry) {
                    arrayChanged = true;
                }
                return nextEntry;
            });
            return arrayChanged ? nextArray : value;
        }

        if (!isPlainObject(value)) {
            return value;
        }

        let objectChanged = false;
        const nextObject = {};

        for (const [key, entry] of Object.entries(value)) {
            const nextEntry = renameWithinValue(entry);
            nextObject[key] = nextEntry;
            if (nextEntry !== entry) {
                objectChanged = true;
            }
        }

        return objectChanged ? nextObject : value;
    }

    const nextEnvironments = (environmentsState.environments || []).map((environment) => {
        const nextVariables = renameWithinValue(environment.variables || {});
        if (nextVariables === (environment.variables || {})) {
            return environment;
        }

        return {
            ...environment,
            variables: nextVariables,
        };
    });

    const changed = nextEnvironments.some((environment, index) => environment !== environmentsState.environments?.[index]);

    return changed
        ? {
            ...environmentsState,
            environments: nextEnvironments,
        }
        : environmentsState;
}
