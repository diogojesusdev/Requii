export { };

declare global {
    interface RequiiWindowState {
        isMaximized: boolean;
        isMinimized: boolean;
    }

    interface RequiiZoomState {
        zoomLevel: number;
    }

    interface RequiiBridge {
        getWindowState: () => Promise<RequiiWindowState>;
        minimizeWindow: () => Promise<boolean>;
        toggleMaximizeWindow: () => Promise<RequiiWindowState>;
        closeWindow: () => Promise<boolean>;
        onWindowStateChange: (listener: (state: RequiiWindowState) => void) => () => void;
        onZoomChange: (listener: (state: RequiiZoomState) => void) => () => void;
        bootstrapWorkspace: () => Promise<any>;
        listWorkspaces: () => Promise<any>;
        openWorkspace: (workspaceId: string) => Promise<any>;
        replaceWorkspaceStructure: (workspacePath: string, payload: any) => Promise<any>;
        saveWorkspaceUiState: (workspaceId: string, uiState: any) => Promise<boolean>;
        openWorkspaceFolder: (workspacePath: string) => Promise<boolean>;
        createWorkspace: (name: string) => Promise<any>;
        renameWorkspace: (workspaceId: string, name: string) => Promise<any>;
        deleteWorkspace: (workspaceId: string) => Promise<any>;
        importWorkspace: (source?: string) => Promise<any>;
        loadWorkspace: (workspacePath: string) => Promise<any>;
        saveRequest: (workspacePath: string, request: any) => Promise<any>;
        createFolder: (workspacePath: string, parentPath: string, folderName: string) => Promise<any>;
        renameFolder: (workspacePath: string, folderPath: string, nextName: string) => Promise<any>;
        moveFolder: (workspacePath: string, folderPath: string, targetParentPath: string, insertIndex: number | null) => Promise<any>;
        deleteFolder: (workspacePath: string, folderPath: string) => Promise<any>;
        deleteRequest: (workspacePath: string, request: any) => Promise<any>;
        createRequest: (workspacePath: string, parentPath: string, name: string) => Promise<any>;
        saveEnvironments: (workspacePath: string, environments: any) => Promise<any>;
        fetchOAuth2Token: (oauth2: any, activeEnvironment: any) => Promise<any>;
        executeRequest: (request: any, activeEnvironment: any) => Promise<any>;
        copyRequestAsCurl: (request: any, activeEnvironment: any, target?: 'powershell' | 'cmd' | 'bash') => Promise<string>;
        exportWorkspace: (workspacePath: string, selection?: any) => Promise<string | null>;
        exportRequest: (workspacePath: string, request: any) => Promise<string | null>;
        importPayload: (workspacePath: string) => Promise<any>;
    }

    interface Window {
        requii: RequiiBridge;
    }
}
