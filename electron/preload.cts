const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('requii', {
    getWindowState: () => ipcRenderer.invoke('window:get-state'),
    minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
    toggleMaximizeWindow: () => ipcRenderer.invoke('window:toggle-maximize'),
    closeWindow: () => ipcRenderer.invoke('window:close'),
    onWindowStateChange: (listener) => {
        const wrappedListener = (_, state) => listener(state);
        ipcRenderer.on('window:state-changed', wrappedListener);
        return () => ipcRenderer.removeListener('window:state-changed', wrappedListener);
    },
    onZoomChange: (listener) => {
        const wrappedListener = (_, payload) => listener(payload);
        ipcRenderer.on('window:zoom-changed', wrappedListener);
        return () => ipcRenderer.removeListener('window:zoom-changed', wrappedListener);
    },
    bootstrapWorkspace: () => ipcRenderer.invoke('workspace:bootstrap'),
    listWorkspaces: () => ipcRenderer.invoke('workspace:list'),
    openWorkspace: (workspaceId) => ipcRenderer.invoke('workspace:open', workspaceId),
    replaceWorkspaceStructure: (workspacePath, payload) => ipcRenderer.invoke('workspace:replace-structure', { workspacePath, payload }),
    saveWorkspaceUiState: (workspaceId, uiState) => ipcRenderer.invoke('workspace:save-ui-state', { workspaceId, uiState }),
    openWorkspaceFolder: (workspacePath) => ipcRenderer.invoke('workspace:open-folder', { workspacePath }),
    createWorkspace: (name) => ipcRenderer.invoke('workspace:create', { name }),
    renameWorkspace: (workspaceId, name) => ipcRenderer.invoke('workspace:rename', { workspaceId, name }),
    deleteWorkspace: (workspaceId) => ipcRenderer.invoke('workspace:delete', { workspaceId }),
    importWorkspace: (source = 'requii') => ipcRenderer.invoke('workspace:import', { source }),
    loadWorkspace: (workspacePath) => ipcRenderer.invoke('workspace:load', workspacePath),
    saveRequest: (workspacePath, request) => ipcRenderer.invoke('request:save', { workspacePath, request }),
    createFolder: (workspacePath, parentPath, folderName) =>
        ipcRenderer.invoke('folder:create', { workspacePath, parentPath, folderName }),
    renameFolder: (workspacePath, folderPath, nextName) =>
        ipcRenderer.invoke('folder:rename', { workspacePath, folderPath, nextName }),
    moveFolder: (workspacePath, folderPath, targetParentPath, insertIndex) =>
        ipcRenderer.invoke('folder:move', { workspacePath, folderPath, targetParentPath, insertIndex }),
    deleteFolder: (workspacePath, folderPath) =>
        ipcRenderer.invoke('folder:delete', { workspacePath, folderPath }),
    deleteRequest: (workspacePath, request) =>
        ipcRenderer.invoke('request:delete', { workspacePath, request }),
    createRequest: (workspacePath, parentPath, name) =>
        ipcRenderer.invoke('request:create', { workspacePath, parentPath, name }),
    saveEnvironments: (workspacePath, environments) =>
        ipcRenderer.invoke('environment:save', { workspacePath, environments }),
    fetchOAuth2Token: (oauth2, activeEnvironment) =>
        ipcRenderer.invoke('oauth2:fetch-token', { oauth2, activeEnvironment }),
    executeRequest: (request, activeEnvironment) =>
        ipcRenderer.invoke('request:execute', { request, activeEnvironment }),
    copyRequestAsCurl: (request, activeEnvironment, target = 'powershell') =>
        ipcRenderer.invoke('request:copy-curl', { request, activeEnvironment, target }),
    exportWorkspace: (workspacePath, selection) => ipcRenderer.invoke('export:workspace', { workspacePath, selection }),
    exportRequest: (workspacePath, request) => ipcRenderer.invoke('export:request', { workspacePath, request }),
    importPayload: (workspacePath) => ipcRenderer.invoke('import:payload', { workspacePath }),
    pickFile: () => ipcRenderer.invoke('file:pick'),
});