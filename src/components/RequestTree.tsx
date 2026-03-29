import { useEffect, useRef, useState } from 'react';
import { CopyIcon, DragHandleIcon, FolderIcon, NewFolderIcon, NewRequestIcon, PencilIcon, TrashIcon } from './icons';

export function TreeSection({ node, activeRequestId, onOpenRequest, onRenameRequest, onDeleteRequest, onDuplicateRequest, onCreateFolder, onCreateRequest, onDeleteFolder, onRenameFolder, draggedRequestId, requestDropTarget, onRequestDragStart, onRequestDragEnd, onRequestDragOverFolder, onRequestDragOverRequest, onRequestDragOverGap, onRequestDropOnFolder, onRequestDropOnRequest, onRequestDropOnGap, draggedFolderPath, folderDropTarget, onFolderDragStart, onFolderDragEnd, expandedFolderPathSet = new Set(), onToggleFolder, emptyMessage = 'This folder is empty.' }) {
    const folders = node?.folders || [];
    const requests = node?.requests || [];
    const nodePath = node?.path || '';
    const isFolderDropTarget = requestDropTarget?.type === 'folder' && (requestDropTarget.folderPath || '') === nodePath;
    const isRootSection = nodePath === '';
    const draggedFolderIndex = folders.findIndex((folder) => folder.path === draggedFolderPath);
    const isInvalidFolderSection = Boolean(draggedFolderPath) && (nodePath === draggedFolderPath || nodePath.startsWith(`${draggedFolderPath}/`));
    const draggedRequestIndex = requests.findIndex((request) => request.id === draggedRequestId);

    function shouldShowGap(insertIndex) {
        if (!draggedRequestId) {
            return false;
        }

        if (draggedRequestIndex === -1) {
            return true;
        }

        return insertIndex !== draggedRequestIndex && insertIndex !== draggedRequestIndex + 1;
    }

    function shouldShowFolderGap(insertIndex) {
        if (!draggedFolderPath || isInvalidFolderSection) {
            return false;
        }

        if (draggedFolderIndex === -1) {
            return true;
        }

        return insertIndex !== draggedFolderIndex && insertIndex !== draggedFolderIndex + 1;
    }

    return (
        <div className={`space-y-1 text-sm transition-all ${isFolderDropTarget ? 'rounded-xl bg-black/[0.04] p-1.5' : ''}`}>
            {isRootSection && draggedRequestId ? <RequestDropGap isVisible={shouldShowGap(0)} isActive={requestDropTarget?.type === 'gap' && (requestDropTarget.folderPath || '') === '' && requestDropTarget.insertIndex === 0} folderPath="" insertIndex={0} label="Drop at workspace root" /> : null}
            {requests.map((request, index) => (
                <div key={request.id} className="space-y-0">
                    <RequestDropGap isVisible={shouldShowGap(index)} isActive={requestDropTarget?.type === 'gap' && (requestDropTarget.folderPath || '') === nodePath && requestDropTarget.insertIndex === index} folderPath={nodePath} insertIndex={index} />
                    <RequestTreeRow request={request} requestFolderPath={nodePath} isActive={request.id === activeRequestId} isDragging={draggedRequestId === request.id} requestDropTarget={requestDropTarget} onOpenRequest={onOpenRequest} onRenameRequest={onRenameRequest} onDeleteRequest={onDeleteRequest} onDuplicateRequest={onDuplicateRequest} onRequestDragStart={onRequestDragStart} onRequestDragEnd={onRequestDragEnd} onRequestDragOverRequest={onRequestDragOverRequest} onRequestDropOnRequest={onRequestDropOnRequest} />
                </div>
            ))}
            {requests.length > 0 ? <RequestDropGap isVisible={shouldShowGap(requests.length)} isActive={requestDropTarget?.type === 'gap' && (requestDropTarget.folderPath || '') === nodePath && requestDropTarget.insertIndex === requests.length} folderPath={nodePath} insertIndex={requests.length} /> : null}
            {isRootSection && draggedFolderPath ? <FolderDropGap isVisible={shouldShowFolderGap(0)} isActive={folderDropTarget?.type === 'gap' && (folderDropTarget.folderPath || '') === '' && folderDropTarget.insertIndex === 0} folderPath="" insertIndex={0} label="Drop folder at workspace root" /> : null}
            {folders.map((folder, index) => (
                <div key={folder.path} className="space-y-0">
                    <FolderDropGap isVisible={shouldShowFolderGap(index)} isActive={folderDropTarget?.type === 'gap' && (folderDropTarget.folderPath || '') === nodePath && folderDropTarget.insertIndex === index} folderPath={nodePath} insertIndex={index} />
                    <FolderNode folder={folder} folderIndex={index} activeRequestId={activeRequestId} onOpenRequest={onOpenRequest} onRenameRequest={onRenameRequest} onDeleteRequest={onDeleteRequest} onDuplicateRequest={onDuplicateRequest} onCreateFolder={onCreateFolder} onCreateRequest={onCreateRequest} onDeleteFolder={onDeleteFolder} onRenameFolder={onRenameFolder} draggedRequestId={draggedRequestId} requestDropTarget={requestDropTarget} onRequestDragStart={onRequestDragStart} onRequestDragEnd={onRequestDragEnd} onRequestDragOverFolder={onRequestDragOverFolder} onRequestDragOverRequest={onRequestDragOverRequest} onRequestDragOverGap={onRequestDragOverGap} onRequestDropOnFolder={onRequestDropOnFolder} onRequestDropOnRequest={onRequestDropOnRequest} onRequestDropOnGap={onRequestDropOnGap} draggedFolderPath={draggedFolderPath} folderDropTarget={folderDropTarget} onFolderDragStart={onFolderDragStart} onFolderDragEnd={onFolderDragEnd} expandedFolderPathSet={expandedFolderPathSet} onToggleFolder={onToggleFolder} />
                </div>
            ))}
            {folders.length > 0 ? <FolderDropGap isVisible={shouldShowFolderGap(folders.length)} isActive={folderDropTarget?.type === 'gap' && (folderDropTarget.folderPath || '') === nodePath && folderDropTarget.insertIndex === folders.length} folderPath={nodePath} insertIndex={folders.length} /> : null}
            {folders.length === 0 && requests.length === 0 ? <p className="rounded-xl bg-[#e6d7c1]/78 px-3 py-3 text-ink/55">{emptyMessage}</p> : null}
        </div>
    );
}

function FolderNode({ folder, folderIndex, activeRequestId, onOpenRequest, onRenameRequest, onDeleteRequest, onDuplicateRequest, onCreateFolder, onCreateRequest, onDeleteFolder, onRenameFolder, draggedRequestId, requestDropTarget, onRequestDragStart, onRequestDragEnd, onRequestDragOverFolder, onRequestDragOverRequest, onRequestDragOverGap, onRequestDropOnFolder, onRequestDropOnRequest, onRequestDropOnGap, draggedFolderPath, folderDropTarget, onFolderDragStart, onFolderDragEnd, expandedFolderPathSet, onToggleFolder }) {
    const [isEditing, setIsEditing] = useState(false);
    const [draftName, setDraftName] = useState(folder.name);
    const containerRef = useRef(null);
    const headerRef = useRef(null);
    const expanded = expandedFolderPathSet.has(folder.path);
    const isRequestDropTarget = requestDropTarget?.type === 'folder' && requestDropTarget.folderPath === folder.path;
    const isFolderDropTarget = folderDropTarget?.type === 'folder' && folderDropTarget.folderPath === folder.path;
    const isInvalidFolderDropTarget = Boolean(draggedFolderPath) && (folder.path === draggedFolderPath || folder.path.startsWith(`${draggedFolderPath}/`));
    const parentPath = folder.path.includes('/') ? folder.path.slice(0, folder.path.lastIndexOf('/')) : '';
    const folderDropProps = isInvalidFolderDropTarget
        ? {}
        : {
            'data-folder-drop-type': 'folder',
            'data-folder-path': folder.path,
            'data-folder-parent-path': parentPath,
            'data-folder-index': folderIndex,
        };

    useEffect(() => {
        setDraftName(folder.name);
    }, [folder.path, folder.name]);

    async function saveName() {
        const trimmed = draftName.trim();
        if (!trimmed) {
            setDraftName(folder.name);
            setIsEditing(false);
            return;
        }

        if (trimmed !== folder.name) {
            const renamed = await onRenameFolder(folder.path, trimmed);
            if (!renamed) {
                setDraftName(folder.name);
                return;
            }
        }

        setIsEditing(false);
    }

    function cancelEditing() {
        setDraftName(folder.name);
        setIsEditing(false);
    }

    return (
        <div ref={containerRef} className={`relative rounded-xl bg-black/[0.06] px-1.5 py-1.5 transition-all ${isRequestDropTarget ? 'ring-2 ring-ink/20 bg-black/[0.08]' : ''} ${isFolderDropTarget ? 'ring-2 ring-[#8e6b2a]/35 bg-[#d4c19e]' : ''} ${draggedFolderPath === folder.path ? 'opacity-35' : ''}`} data-request-drop-type="folder" data-folder-path={folder.path} data-tree-folder-path={folder.path} {...folderDropProps}>
            <div ref={headerRef} className="flex items-center gap-0.5" data-folder-drop-header>
                <button
                    className="icon-action-button h-6 w-6 cursor-grab"
                    title="Drag folder"
                    onMouseDown={(event) => onFolderDragStart(event, folder.path, containerRef.current)}
                    onClick={(event) => event.preventDefault()}
                    disabled={isEditing}
                    type="button"
                >
                    <DragHandleIcon />
                </button>
                {isEditing ? (
                    <div className="flex min-w-0 flex-1 items-center gap-1 rounded-lg px-1.5 py-1.5 text-left font-semibold">
                        <span className="text-xs text-ink/45">{expanded ? '▾' : '▸'}</span>
                        <FolderIcon />
                        <input
                            autoFocus
                            className="w-full rounded-lg border border-black/10 bg-[#ece0cb] px-2 py-1 text-sm font-semibold text-ink outline-none"
                            value={draftName}
                            spellCheck={false}
                            onChange={(event) => setDraftName(event.target.value)}
                            onBlur={() => {
                                void saveName();
                            }}
                            onKeyDown={(event) => {
                                if (event.key === 'Enter') {
                                    event.preventDefault();
                                    void saveName();
                                }
                                if (event.key === 'Escape') {
                                    event.preventDefault();
                                    cancelEditing();
                                }
                            }}
                        />
                    </div>
                ) : (
                    <button className="flex min-w-0 flex-1 items-center gap-1 truncate rounded-lg px-1.5 py-1.5 text-left font-semibold hover:bg-[#e8dac2]/75" onClick={() => onToggleFolder?.(folder.path, !expanded)}>
                        <span className="text-xs text-ink/45">{expanded ? '▾' : '▸'}</span>
                        <FolderIcon />
                        <span className="truncate">{folder.name}</span>
                    </button>
                )}
                <button
                    className="icon-action-button h-6 w-6"
                    onClick={() => {
                        setDraftName(folder.name);
                        setIsEditing(true);
                    }}
                    title="Rename folder"
                    disabled={isEditing}
                >
                    <PencilIcon />
                </button>
                <button className="icon-action-button h-6 w-6" onClick={() => onCreateFolder(folder.path)} title="New folder">
                    <NewFolderIcon />
                </button>
                <button className="icon-action-button h-6 w-6" onClick={() => onCreateRequest(folder.path)} title="New request">
                    <NewRequestIcon />
                </button>
                <button className="icon-action-button h-6 w-6" onClick={() => onDeleteFolder(folder.path)} title="Delete folder" disabled={isEditing}>
                    <TrashIcon />
                </button>
            </div>
            {expanded ? (
                <div className="mt-1 pl-1.5">
                    <TreeSection node={folder} activeRequestId={activeRequestId} onOpenRequest={onOpenRequest} onRenameRequest={onRenameRequest} onDeleteRequest={onDeleteRequest} onDuplicateRequest={onDuplicateRequest} onCreateFolder={onCreateFolder} onCreateRequest={onCreateRequest} onDeleteFolder={onDeleteFolder} onRenameFolder={onRenameFolder} draggedRequestId={draggedRequestId} requestDropTarget={requestDropTarget} onRequestDragStart={onRequestDragStart} onRequestDragEnd={onRequestDragEnd} onRequestDragOverFolder={onRequestDragOverFolder} onRequestDragOverRequest={onRequestDragOverRequest} onRequestDragOverGap={onRequestDragOverGap} onRequestDropOnFolder={onRequestDropOnFolder} onRequestDropOnRequest={onRequestDropOnRequest} onRequestDropOnGap={onRequestDropOnGap} draggedFolderPath={draggedFolderPath} folderDropTarget={folderDropTarget} onFolderDragStart={onFolderDragStart} onFolderDragEnd={onFolderDragEnd} expandedFolderPathSet={expandedFolderPathSet} onToggleFolder={onToggleFolder} />
                </div>
            ) : null}
        </div>
    );
}

function FolderDropGap({ isVisible = false, isActive, folderPath = '', insertIndex = 0, label = '' }) {
    if (!isVisible) {
        return null;
    }

    return (
        <div
            className="relative z-[1] -my-1.5 h-3"
            data-folder-drop-type="gap"
            data-folder-path={folderPath}
            data-insert-index={insertIndex}
        >
            <span className={`absolute inset-x-1 top-1/2 block h-[2px] -translate-y-1/2 rounded-full transition-all ${isActive ? 'bg-[#8e6b2a]' : 'bg-[#8e6b2a]/28'}`}></span>
            <span className={`absolute left-1 top-1/2 h-[8px] w-[8px] -translate-y-1/2 rounded-full transition-all ${isActive ? 'bg-[#8e6b2a] shadow-[0_0_0_3px_rgba(142,107,42,0.16)]' : 'bg-[#8e6b2a]/35'}`}></span>
            {isActive ? <span className="absolute right-1 top-1/2 -translate-y-1/2 rounded-full bg-[#e5d1af] px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.14em] text-[#6d5121] shadow-sm">{label || 'Move folder here'}</span> : null}
        </div>
    );
}

function RequestDropGap({ isVisible = false, isActive, folderPath = '', insertIndex = 0, label = '' }) {
    if (!isVisible) {
        return null;
    }

    return (
        <div
            className="relative z-[1] -my-1.5 h-3"
            data-request-drop-type="gap"
            data-folder-path={folderPath}
            data-insert-index={insertIndex}
        >
            <span className={`absolute inset-x-1 top-1/2 block h-[2px] -translate-y-1/2 rounded-full transition-all ${isActive ? 'bg-ink' : 'bg-ink/20'}`}></span>
            <span className={`absolute left-1 top-1/2 h-[8px] w-[8px] -translate-y-1/2 rounded-full transition-all ${isActive ? 'bg-ink shadow-[0_0_0_3px_rgba(24,33,27,0.12)]' : 'bg-ink/28'}`}></span>
            {isActive ? <span className="absolute right-1 top-1/2 -translate-y-1/2 rounded-full bg-[#e5d8c4] px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.14em] text-ink shadow-sm">{label || 'Move here'}</span> : null}
        </div>
    );
}

function RequestTreeRow({ request, requestFolderPath = '', isActive, isDragging, requestDropTarget, onOpenRequest, onRenameRequest, onDeleteRequest, onDuplicateRequest, onRequestDragStart, onRequestDragEnd, onRequestDragOverRequest, onRequestDropOnRequest }) {
    const [isEditing, setIsEditing] = useState(false);
    const [draftName, setDraftName] = useState(request.name);
    const [contextMenu, setContextMenu] = useState(null);
    const rowRef = useRef(null);
    const isDropBefore = requestDropTarget?.type === 'request' && requestDropTarget.requestId === request.id && requestDropTarget.position === 'before';
    const isDropAfter = requestDropTarget?.type === 'request' && requestDropTarget.requestId === request.id && requestDropTarget.position === 'after';

    useEffect(() => {
        setDraftName(request.name);
    }, [request.id, request.name]);

    useEffect(() => {
        if (!contextMenu) {
            return undefined;
        }

        function handlePointerDown(event) {
            if (!rowRef.current?.contains(event.target)) {
                setContextMenu(null);
            }
        }

        function handleEscape(event) {
            if (event.key === 'Escape') {
                setContextMenu(null);
            }
        }

        window.addEventListener('pointerdown', handlePointerDown);
        window.addEventListener('keydown', handleEscape);

        return () => {
            window.removeEventListener('pointerdown', handlePointerDown);
            window.removeEventListener('keydown', handleEscape);
        };
    }, [contextMenu]);

    function saveName() {
        const trimmed = draftName.trim();
        if (!trimmed) {
            setDraftName(request.name);
            setIsEditing(false);
            return;
        }

        if (trimmed !== request.name) {
            onRenameRequest(request.id, (current) => ({ ...current, name: trimmed }));
        }

        setIsEditing(false);
    }

    function cancelEditing() {
        setDraftName(request.name);
        setIsEditing(false);
    }

    async function handleDuplicateRequest() {
        setContextMenu(null);
        await onDuplicateRequest?.(request, requestFolderPath);
    }

    return (
        <div
            ref={rowRef}
            className={`relative flex items-center gap-0.5 rounded-lg px-2 py-1 transition-all duration-150 ${isActive ? 'bg-[#7d674b] text-paper shadow-[inset_0_1px_0_rgba(255,244,220,0.1)]' : 'bg-[#e7dac4]/82 text-ink hover:bg-[#efe2cc]'} ${isDragging ? 'scale-[0.98] opacity-35' : ''}`}
            style={isDragging ? { transform: 'scale(0.98)' } : undefined}
            data-folder-drop-type="folder-via-request"
            data-folder-path={requestFolderPath}
            data-tree-request-id={request.id}
            onContextMenu={(event) => {
                event.preventDefault();
                if (isEditing) {
                    return;
                }

                setContextMenu({ x: event.clientX, y: event.clientY });
            }}
        >
            {isDropBefore ? <span className="pointer-events-none absolute inset-x-1 top-0 block h-[2px] rounded-full bg-ink shadow-[0_0_0_3px_rgba(24,33,27,0.12)]"></span> : null}
            {isDropAfter ? <span className="pointer-events-none absolute inset-x-1 bottom-0 block h-[2px] rounded-full bg-ink shadow-[0_0_0_3px_rgba(24,33,27,0.12)]"></span> : null}
            <button
                className={`icon-action-button h-6 w-6 cursor-grab ${isActive ? 'border-black/20 bg-black/10 text-paper hover:bg-black/15' : ''}`}
                title="Drag request"
                onMouseDown={(event) => onRequestDragStart(event, request.id, rowRef.current)}
                onClick={(event) => event.preventDefault()}
                disabled={isEditing}
                type="button"
            >
                <DragHandleIcon />
            </button>
            <button className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => onOpenRequest(request.id)} draggable={false}>
                <span className="shrink-0 text-[11px] font-semibold tracking-wide ml-1 opacity-70">{request.method}</span>
                {isEditing ? (
                    <input
                        autoFocus
                        className={`w-full rounded-lg border px-2 py-1 text-sm font-medium outline-none ${isActive ? 'border-black/20 bg-black/10 text-paper' : 'border-black/10 bg-[#ece0cb] text-ink'}`}
                        value={draftName}
                        spellCheck={false}
                        onChange={(event) => setDraftName(event.target.value)}
                        onClick={(event) => event.stopPropagation()}
                        onBlur={saveName}
                        onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                                saveName();
                            }
                            if (event.key === 'Escape') {
                                event.preventDefault();
                                cancelEditing();
                            }
                        }}
                    />
                ) : (
                    <span className="truncate font-medium">{request.name}</span>
                )}
            </button>
            <div className="ml-0.5 flex items-center gap-0.5">
                <button
                    className={`icon-action-button h-6 w-6 ${isActive ? 'border-black/20 bg-black/10 text-paper hover:bg-black/15' : ''}`}
                    onClick={() => {
                        setDraftName(request.name);
                        setIsEditing(true);
                    }}
                    title="Rename request"
                    disabled={isEditing}
                    type="button"
                >
                    <PencilIcon />
                </button>
                <button
                    className={`icon-action-button h-6 w-6 ${isActive ? 'border-black/20 bg-black/10 text-paper hover:bg-black/15' : ''}`}
                    onClick={() => onDeleteRequest(request)}
                    title="Delete request"
                    disabled={isEditing}
                    type="button"
                >
                    <TrashIcon />
                </button>
            </div>
            {contextMenu ? (
                <div
                    className="fixed z-[210] min-w-[180px] overflow-hidden rounded-xl border border-black/15 bg-[#e7dac6] p-1.5 shadow-2xl"
                    style={{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }}
                >
                    <button className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-ink transition hover:bg-black/[0.06]" onClick={() => void handleDuplicateRequest()} type="button">
                        <CopyIcon />
                        <span>Duplicate Request</span>
                    </button>
                </div>
            ) : null}
        </div>
    );
}