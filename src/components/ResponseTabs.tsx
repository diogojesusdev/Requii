import { CodeMiniEditor } from './CodeMiniEditor';
import { RESPONSE_TABS } from '../constants';
import { CloseIcon, ExpandIcon } from './icons';

function inferResponseEditorLanguage(response) {
    const contentTypeHeader = response?.headers?.['content-type'] || response?.headers?.['Content-Type'] || '';
    const contentType = String(contentTypeHeader || '').toLowerCase();

    if (contentType.includes('json')) {
        return 'json';
    }

    if (contentType.includes('html')) {
        return 'html';
    }

    if (contentType.includes('xml')) {
        return 'xml';
    }

    if (contentType.includes('javascript')) {
        return 'javascript';
    }

    const body = String(response?.data || '').trim();
    if (body.startsWith('{') || body.startsWith('[')) {
        try {
            JSON.parse(body);
            return 'json';
        } catch {
            return 'plaintext';
        }
    }

    return 'plaintext';
}

function formatResponseHeaders(response) {
    try {
        return JSON.stringify(response?.headers || {}, null, 2);
    } catch {
        return '{}';
    }
}

export function ResponseTabs({ response, activeTab, onSelect, onOpenBodyPopup }) {
    const responseLanguage = inferResponseEditorLanguage(response);
    const responseHeadersValue = formatResponseHeaders(response);

    return (
        <section className="flex min-h-0 min-w-0 w-full max-w-full flex-col overflow-hidden rounded-2xl border border-black/5 bg-[#e2d0b4]/88">
            <div className="flex min-w-0 gap-1 overflow-x-auto border-b border-black/12 px-1.5 py-1.5">
                {RESPONSE_TABS.map((tab) => {
                    const active = tab === activeTab;
                    return (
                        <button key={tab} className={`rounded-lg border px-2.5 py-1.5 text-sm font-medium capitalize transition ${active ? 'border-black/20 bg-[#8f7758] text-[#f3e5cf] shadow-[inset_0_1px_0_rgba(255,244,220,0.12)]' : 'border-transparent text-ink/60 hover:bg-black/[0.06]'}`} onClick={() => onSelect(tab)}>
                            {tab}
                        </button>
                    );
                })}
            </div>
            <div className="min-h-0 min-w-0 flex-1 overflow-hidden p-2.5">
                {!response ? (
                    <div className="flex h-full min-h-[260px] items-center justify-center rounded-xl border border-dashed border-black/12 bg-[#e6d7c1]/70 text-sm text-ink/55">
                        Send the request to see the response.
                    </div>
                ) : !response.hasResponse ? (
                    <div className="flex h-full min-h-0 min-w-0 w-full max-w-full flex-col gap-2 overflow-hidden rounded-xl border border-[#b42318]/20 bg-[#ecd2c8] p-2.5 text-sm text-ink/75">
                        <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
                            <div className="min-w-0 flex-1">
                                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#b42318]">Request Failure</p>
                                <h3 className="mt-0.5 text-base font-semibold leading-5 text-ink">{response.error?.title || 'Request failed'}</h3>
                                <p className="mt-1 line-clamp-2 text-sm text-ink/70">{response.error?.summary || 'The request failed before a usable HTTP response was available.'}</p>
                            </div>
                            <span className="max-w-full rounded-full bg-[#b42318] px-2 py-0.5 text-[11px] font-semibold text-white break-words">No HTTP response</span>
                        </div>

                        <div className="grid min-h-0 min-w-0 gap-2 md:grid-cols-2">
                            <div className="min-h-0 min-w-0 rounded-xl bg-[#e5d7c3]/88 p-2">
                                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-ink/45">What Happened</p>
                                <div className="mt-1 max-h-28 overflow-y-auto overflow-x-hidden rounded-lg bg-[#eadbc6]/58 px-2 py-1.5">
                                    <p className="whitespace-pre-wrap break-all text-sm text-ink/75">{response.error?.detail || response.data}</p>
                                </div>
                            </div>
                            <div className="min-h-0 min-w-0 rounded-xl bg-[#e5d7c3]/88 p-2">
                                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-ink/45">What To Check</p>
                                <div className="mt-1 max-h-28 overflow-y-auto overflow-x-hidden rounded-lg bg-[#eadbc6]/58 px-2 py-1.5">
                                    <p className="whitespace-pre-wrap break-all text-sm text-ink/75">{response.error?.suggestion || 'Check the request URL and connectivity, then try again.'}</p>
                                </div>
                                {response.error?.code ? <p className="mt-2 break-all text-xs font-mono text-ink/45">Code: {response.error.code}</p> : null}
                            </div>
                        </div>

                        {activeTab === 'headers' ? (
                            <div className="rounded-xl border border-dashed border-black/10 bg-[#e6d7c1]/72 p-2.5 text-sm text-ink/60">No response headers are available because the request never received an HTTP response.</div>
                        ) : response.requestPreview ? (
                            <div className="min-h-0 min-w-0 flex-1 rounded-xl bg-[#e5d7c3]/88 p-2">
                                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-ink/45">Prepared Request</p>
                                <pre className="mt-1 max-h-32 max-w-full overflow-auto whitespace-pre-wrap break-all rounded-lg bg-[#eadbc6]/72 p-2 text-xs text-ink/70">{JSON.stringify(response.requestPreview, null, 2)}</pre>
                            </div>
                        ) : null}
                    </div>
                ) : activeTab === 'headers' ? (
                    <div className="h-full min-h-0">
                        <CodeMiniEditor
                            value={responseHeadersValue}
                            onChange={() => { }}
                            language="json"
                            readOnly
                            fillContainer
                            headerActions={
                                <button
                                    className="icon-action-button h-6 w-6 border-transparent bg-transparent text-ink/60 hover:bg-black/[0.05]"
                                    onClick={() => onOpenBodyPopup({ title: `Response Headers • ${response.status}`, value: responseHeadersValue, language: 'json' })}
                                    title="Open response headers in larger viewer"
                                    type="button"
                                >
                                    <ExpandIcon />
                                </button>
                            }
                        />
                    </div>
                ) : (
                    <div className="h-full min-h-0">
                        <CodeMiniEditor
                            value={String(response.data || '')}
                            onChange={() => { }}
                            language={responseLanguage}
                            readOnly
                            fillContainer
                            headerActions={
                                <button
                                    className="icon-action-button h-6 w-6 border-transparent bg-transparent text-ink/60 hover:bg-black/[0.05]"
                                    onClick={() => onOpenBodyPopup({ title: `Response Body • ${response.status}`, value: String(response.data || ''), language: responseLanguage })}
                                    title="Open response body in larger viewer"
                                    type="button"
                                >
                                    <ExpandIcon />
                                </button>
                            }
                        />
                    </div>
                )}
            </div>
        </section>
    );
}

export function ResponseBodyDialog({ viewer, onClose }) {
    return (
        <div className="fixed inset-0 z-[260] flex items-center justify-center bg-ink/35 p-4 backdrop-blur-sm">
            <div className="flex w-full max-w-6xl flex-col rounded-3xl border border-black/15 bg-[#d7c19d] p-5 shadow-2xl">
                <div className="flex items-start justify-between gap-4">
                    <div>
                        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-ink/45">Response Viewer</p>
                        <h2 className="mt-1 text-2xl font-black tracking-tight text-ink">{viewer.title}</h2>
                    </div>
                    <button className="icon-action-button" onClick={onClose} title="Close response viewer" type="button">
                        <CloseIcon />
                    </button>
                </div>
                <div className="mt-4">
                    <CodeMiniEditor value={viewer.value} onChange={() => { }} language={viewer.language || 'plaintext'} height="68vh" readOnly />
                </div>
            </div>
        </div>
    );
}