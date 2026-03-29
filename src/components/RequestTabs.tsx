import { useEffect, useState } from 'react';
import { CloseIcon, DragHandleIcon, PencilIcon } from './icons';

export function RequestTabs({ tabs, requests, activeRequestId, draggedTabId, onSelect, onRename, onClose, onTabDragStart, onTabDragOver, onTabDragEnd }) {
    if (tabs.length === 0) {
        return <p className="px-1 text-sm text-ink/50">No open request tabs.</p>;
    }

    return (
        <div className="flex gap-1.5 overflow-x-auto overflow-y-hidden pb-1" role="tablist" aria-label="Open request tabs">
            {tabs.map((tabId) => {
                const request = requests.find((item) => item.id === tabId);
                if (!request) {
                    return null;
                }

                const active = tabId === activeRequestId;
                return (
                    <RequestTab key={tabId} request={request} active={active} isDragged={draggedTabId === tabId} draggedTabId={draggedTabId} onSelect={onSelect} onRename={onRename} onClose={onClose} onDragStart={onTabDragStart} onDragOverTab={onTabDragOver} onDragEnd={onTabDragEnd} />
                );
            })}
        </div>
    );
}

function RequestTab({ request, active, isDragged, draggedTabId, onSelect, onRename, onClose, onDragStart, onDragOverTab, onDragEnd }) {
    const [isEditing, setIsEditing] = useState(false);
    const [draftName, setDraftName] = useState(request.name);

    useEffect(() => {
        setDraftName(request.name);
    }, [request.id, request.name]);

    function saveName() {
        const trimmed = draftName.trim();
        if (!trimmed) {
            setDraftName(request.name);
            setIsEditing(false);
            return;
        }

        if (trimmed !== request.name) {
            onRename(request.id, (current) => ({ ...current, name: trimmed }));
        }

        setIsEditing(false);
    }

    function cancelEditing() {
        setDraftName(request.name);
        setIsEditing(false);
    }

    function selectTab() {
        if (!isEditing) {
            onSelect(request.id);
        }
    }

    function handleDragStart(event) {
        if (isEditing) {
            event.preventDefault();
            return;
        }

        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', request.id);
        onDragStart(request.id);
    }

    function handleDragOver(event) {
        if (!draggedTabId || draggedTabId === request.id) {
            return;
        }

        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';

        const bounds = event.currentTarget.getBoundingClientRect();
        const midpoint = bounds.left + bounds.width / 2;
        const position = event.clientX < midpoint ? 'before' : 'after';
        onDragOverTab(draggedTabId, request.id, position);
    }

    return (
        <div
            className={`flex min-w-0 shrink-0 items-center justify-between gap-1.5 rounded-t-lg border px-2 py-1.5 transition ${active ? 'border-black/10 border-b-[#d1c1a5] bg-[#d1c1a5] text-ink' : 'cursor-pointer border-transparent bg-[#e7dac5]/32 text-ink/50 hover:bg-[#eadcc7]/52 hover:text-ink/78'} ${isDragged ? 'opacity-45' : ''}`}
            style={{ width: 'fit-content', minWidth: 'min(180px, 100%)', maxWidth: '100%' }}
            onClick={selectTab}
            onKeyDown={(event) => {
                if (event.target !== event.currentTarget) {
                    return;
                }

                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    selectTab();
                }
            }}
            draggable={!isEditing}
            onDragStart={handleDragStart}
            onDragOver={handleDragOver}
            onDrop={(event) => {
                event.preventDefault();
                onDragEnd();
            }}
            onDragEnd={onDragEnd}
            role="tab"
            aria-selected={active}
            tabIndex={isEditing ? -1 : 0}
        >
            <div className="flex min-w-0 flex-1 items-center gap-1.5">
                <span className={`shrink-0 opacity-55 ${active ? 'text-ink/70' : 'text-inherit'}`} title="Drag tab" aria-hidden="true">
                    <DragHandleIcon />
                </span>
                {isEditing ? (
                    <input
                        autoFocus
                        className="w-full rounded-lg border border-black/10 bg-[#ece0cb] px-2 py-1 text-sm font-semibold text-ink outline-none"
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
                    <div className={`truncate text-left text-sm font-semibold ${active ? 'text-ink' : 'text-inherit'}`}>{request.name}</div>
                )}
                <button
                    className="icon-action-button h-6 w-6 border-transparent bg-transparent text-ink/60 hover:bg-black/[0.05]"
                    onClick={(event) => {
                        event.stopPropagation();
                        setDraftName(request.name);
                        setIsEditing(true);
                    }}
                    draggable={false}
                    title="Rename request"
                    disabled={isEditing}
                >
                    <PencilIcon />
                </button>
            </div>
            <button
                className="icon-action-button h-6 w-6 border-transparent bg-transparent text-ink/60 hover:bg-black/[0.05]"
                onClick={(event) => {
                    event.stopPropagation();
                    onClose(request.id);
                }}
                draggable={false}
                title="Close request tab"
            >
                <CloseIcon />
            </button>
        </div>
    );
}