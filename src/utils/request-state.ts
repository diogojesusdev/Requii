export function createRow() {
    return { key: '', value: '', enabled: true };
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

function ensureAuthShape(auth) {
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

function ensureBodyShape(body) {
    const content = typeof body?.content === 'string' ? body.content : '';
    const normalizedType = String(body?.type || '').trim().toLowerCase();

    if (normalizedType === 'json' || normalizedType.includes('json')) {
        return {
            type: 'json',
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
        type: 'raw',
        content,
    };
}

export function ensureRequestShape(request) {
    return {
        ...request,
        order: Number.isFinite(request.order) ? request.order : 0,
        headers: Array.isArray(request.headers) ? request.headers : [],
        query_params: Array.isArray(request.query_params) ? request.query_params : [],
        body: ensureBodyShape(request.body),
        auth: ensureAuthShape(request.auth),
    };
}

export function emptyComposer() {
    return {
        open: false,
        type: 'request',
        parentPath: '',
        name: '',
    };
}

export function reorderRequestsCollection(requests, movedRequestId, target) {
    const sortedRequests = [...requests].sort((left, right) => {
        const orderDifference = (left.order ?? 0) - (right.order ?? 0);
        if (orderDifference !== 0) {
            return orderDifference;
        }
        return left.name.localeCompare(right.name);
    });
    const movedRequest = sortedRequests.find((request) => request.id === movedRequestId);
    if (!movedRequest) {
        return { nextRequests: requests, changedRequests: [] };
    }

    const targetPath = target.folderPath || '';
    const sourcePath = movedRequest.path || '';
    const byFolder = new Map();

    for (const request of sortedRequests) {
        const folderPath = request.path || '';
        if (!byFolder.has(folderPath)) {
            byFolder.set(folderPath, []);
        }
        byFolder.get(folderPath).push(request);
    }

    const sourceGroup = [...(byFolder.get(sourcePath) || [])].filter((request) => request.id !== movedRequestId);
    byFolder.set(sourcePath, sourceGroup);

    const destinationGroup = [...(byFolder.get(targetPath) || [])].filter((request) => request.id !== movedRequestId);
    let insertIndex = destinationGroup.length;

    if (typeof target.insertIndex === 'number') {
        insertIndex = Math.max(0, Math.min(target.insertIndex, destinationGroup.length));
    }

    if (typeof target.insertIndex !== 'number' && target.requestId) {
        const targetIndex = destinationGroup.findIndex((request) => request.id === target.requestId);
        if (targetIndex !== -1) {
            insertIndex = target.position === 'before' ? targetIndex : targetIndex + 1;
        }
    }

    const movedNext = { ...movedRequest, path: targetPath };
    destinationGroup.splice(insertIndex, 0, movedNext);
    byFolder.set(targetPath, destinationGroup);

    const updatedRequests = sortedRequests.map((request) => {
        const folderPath = request.id === movedRequestId ? targetPath : request.path || '';
        const group = byFolder.get(folderPath) || [];
        const nextIndex = group.findIndex((item) => item.id === request.id);
        if (nextIndex === -1) {
            return request;
        }

        const nextPath = request.id === movedRequestId ? targetPath : request.path || '';
        return ensureRequestShape({ ...request, path: nextPath, order: nextIndex + 1 });
    });

    const changedRequests = updatedRequests.filter((request) => {
        const previous = requests.find((item) => item.id === request.id);
        return previous && (previous.path !== request.path || previous.order !== request.order || previous.filePath !== request.filePath);
    });

    return { nextRequests: updatedRequests, changedRequests };
}
