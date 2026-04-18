export const requiiIpc = {
    getWindowState() {
        return window.requii.getWindowState();
    },
    minimizeWindow() {
        return window.requii.minimizeWindow();
    },
    toggleMaximizeWindow() {
        return window.requii.toggleMaximizeWindow();
    },
    closeWindow() {
        return window.requii.closeWindow();
    },
    onWindowStateChange(listener) {
        return window.requii.onWindowStateChange(listener);
    },
    onZoomChange(listener) {
        return window.requii.onZoomChange(listener);
    },
    bootstrapWorkspace() {
        return window.requii.bootstrapWorkspace();
    },
    listWorkspaces() {
        return window.requii.listWorkspaces();
    },
    openWorkspace(workspaceId) {
        return window.requii.openWorkspace(workspaceId);
    },
    replaceWorkspaceStructure(workspacePath, payload) {
        return window.requii.replaceWorkspaceStructure(workspacePath, payload);
    },
    saveWorkspaceUiState(workspaceId, uiState) {
        return window.requii.saveWorkspaceUiState(workspaceId, uiState);
    },
    openWorkspaceFolder(workspacePath) {
        return window.requii.openWorkspaceFolder(workspacePath);
    },
    createWorkspace(name) {
        return window.requii.createWorkspace(name);
    },
    renameWorkspace(workspaceId, name) {
        return window.requii.renameWorkspace(workspaceId, name);
    },
    deleteWorkspace(workspaceId) {
        return window.requii.deleteWorkspace(workspaceId);
    },
    importWorkspace(source = 'requii') {
        return window.requii.importWorkspace(source);
    },
    loadWorkspace(workspacePath) {
        return window.requii.loadWorkspace(workspacePath);
    },
    saveRequest(workspacePath, request) {
        return window.requii.saveRequest(workspacePath, request);
    },
    createFolder(workspacePath, parentPath, folderName) {
        return window.requii.createFolder(workspacePath, parentPath, folderName);
    },
    renameFolder(workspacePath, folderPath, nextName) {
        return window.requii.renameFolder(workspacePath, folderPath, nextName);
    },
    moveFolder(workspacePath, folderPath, targetParentPath, insertIndex) {
        return window.requii.moveFolder(workspacePath, folderPath, targetParentPath, insertIndex);
    },
    deleteFolder(workspacePath, folderPath) {
        return window.requii.deleteFolder(workspacePath, folderPath);
    },
    deleteRequest(workspacePath, request) {
        return window.requii.deleteRequest(workspacePath, request);
    },
    createRequest(workspacePath, parentPath, name) {
        return window.requii.createRequest(workspacePath, parentPath, name);
    },
    saveEnvironments(workspacePath, environments) {
        return window.requii.saveEnvironments(workspacePath, environments);
    },
    fetchOAuth2Token(oauth2, activeEnvironment) {
        return window.requii.fetchOAuth2Token(oauth2, activeEnvironment);
    },
    executeRequest(request, activeEnvironment) {
        return window.requii.executeRequest(request, activeEnvironment);
    },
    copyRequestAsCurl(request, activeEnvironment, target: 'powershell' | 'cmd' | 'bash' = 'powershell') {
        return window.requii.copyRequestAsCurl(request, activeEnvironment, target);
    },
    exportWorkspace(workspacePath, selection) {
        return window.requii.exportWorkspace(workspacePath, selection);
    },
    exportRequest(workspacePath, request) {
        return window.requii.exportRequest(workspacePath, request);
    },
    importPayload(workspacePath) {
        return window.requii.importPayload(workspacePath);
    },
    pickFile() {
        return window.requii.pickFile();
    },
};
