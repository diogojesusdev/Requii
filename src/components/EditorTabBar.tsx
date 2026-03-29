export function EditorTabBar({ tabs, activeTab, onSelect }) {
    return (
        <div className="flex gap-1 border-b border-black/12 px-1.5 py-1.5">
            {tabs.map((tab) => {
                const active = tab === activeTab;
                return (
                    <button key={tab} className={`rounded-lg border px-2.5 py-1.5 text-sm font-medium capitalize transition ${active ? 'border-black/20 bg-[#9f8866] text-[#f3e5cf] shadow-[inset_0_1px_0_rgba(255,244,220,0.12)]' : 'border-transparent text-ink/60 hover:bg-black/[0.06]'}`} onClick={() => onSelect(tab)}>
                        {tab}
                    </button>
                );
            })}
        </div>
    );
}