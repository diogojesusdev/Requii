function compareRequests(left, right) {
    const orderDifference = (left.order ?? 0) - (right.order ?? 0);
    if (orderDifference !== 0) {
        return orderDifference;
    }

    return left.name.localeCompare(right.name);
}

function tokenizeSearchTerm(searchTerm) {
    return String(searchTerm || '')
        .trim()
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean);
}

function matchesSearchTokens(tokens, ...values) {
    if (tokens.length === 0) {
        return true;
    }

    const haystack = values
        .filter(Boolean)
        .join(' ')
        .toLowerCase();

    return tokens.every((token) => haystack.includes(token));
}

function collectNestedRequests(node) {
    const nestedRequests = [...(node?.requests || [])];

    for (const folder of node?.folders || []) {
        nestedRequests.push(...collectNestedRequests(folder));
    }

    return nestedRequests.sort(compareRequests);
}

export function buildTree(folders, requests) {
    const root = { folders: [], requests: [] };
    const folderMap = new Map([['', root]]);

    for (const folderPath of folders) {
        const node = {
            path: folderPath,
            name: folderPath.split('/').filter(Boolean).pop() || folderPath,
            folders: [],
            requests: [],
        };
        folderMap.set(folderPath, node);
    }

    for (const folderPath of folders) {
        const parentPath = folderPath.includes('/') ? folderPath.slice(0, folderPath.lastIndexOf('/')) : '';
        const parentNode = folderMap.get(parentPath) || root;
        const node = folderMap.get(folderPath);
        if (node) {
            parentNode.folders.push(node);
        }
    }

    for (const request of [...requests].sort(compareRequests)) {
        const parent = folderMap.get(request.path || '') || root;
        parent.requests.push(request);
    }

    return root;
}

export function filterTree(node, searchTerm) {
    const tokens = Array.isArray(searchTerm) ? searchTerm : tokenizeSearchTerm(searchTerm);
    if (tokens.length === 0) {
        return node;
    }

    const folders = node.folders.map((folder) => filterTree(folder, tokens)).filter(Boolean);
    const requests = node.requests.filter((request) => matchesSearchTokens(tokens, request.name, request.path));
    const folderMatches = matchesSearchTokens(tokens, node.name, node.path);

    if (!node.path) {
        return {
            ...node,
            folders,
            requests,
        };
    }

    if (folderMatches) {
        return {
            ...node,
            folders: [],
            requests: collectNestedRequests(node),
        };
    }

    if (folders.length > 0 || requests.length > 0) {
        return {
            ...node,
            folders,
            requests,
        };
    }

    return null;
}

export function folderNameFromPath(folderPath) {
    return String(folderPath || '')
        .split('/')
        .filter(Boolean)
        .pop() || '';
}
