export const BASE_ENVIRONMENT_ID = 'env_base';
export const BASE_ENVIRONMENT_NAME = 'Base Environment';
export const BASE_ENVIRONMENT_PREFIX = '_BASE_ENV';

export const EMPTY_ENVIRONMENTS = {
    active_environment_id: 'env_default',
    base_environment: {
        id: BASE_ENVIRONMENT_ID,
        name: BASE_ENVIRONMENT_NAME,
        variables: {},
    },
    environments: [
        {
            id: 'env_default',
            name: 'Default',
            variables: {},
        },
    ],
};

export const METHOD_OPTIONS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
export const REQUEST_EDITOR_TABS = ['query', 'body', 'auth', 'headers'];
export const RESPONSE_TABS = ['body', 'headers'];
export const COMMON_HEADER_KEY_SUGGESTIONS = [
    { value: 'Accept', detail: 'Preferred response media types' },
    { value: 'Accept-Encoding', detail: 'Supported response compression' },
    { value: 'Accept-Language', detail: 'Preferred response languages' },
    { value: 'Authorization', detail: 'Authentication credentials' },
    { value: 'Cache-Control', detail: 'Caching directives' },
    { value: 'Connection', detail: 'Connection behavior' },
    { value: 'Content-Type', detail: 'Request payload media type' },
    { value: 'Cookie', detail: 'Cookies sent to the server' },
    { value: 'If-None-Match', detail: 'Conditional request using ETag' },
    { value: 'Origin', detail: 'Originating domain' },
    { value: 'Pragma', detail: 'Legacy caching directives' },
    { value: 'Referer', detail: 'Previous page URL' },
    { value: 'User-Agent', detail: 'Client user agent string' },
    { value: 'X-API-Key', detail: 'Common API key header' },
    { value: 'X-Requested-With', detail: 'AJAX request hint' },
];
export const COMMON_HEADER_VALUE_SUGGESTIONS = {
    accept: [
        { value: 'application/json', detail: 'JSON responses' },
        { value: 'application/json, text/plain, */*', detail: 'JSON-first broad fallback' },
        { value: '*/*', detail: 'Accept any content type' },
        { value: 'text/plain', detail: 'Plain text responses' },
        { value: 'text/html', detail: 'HTML responses' },
    ],
    'accept-encoding': [
        { value: 'gzip, deflate, br', detail: 'Common compressed encodings' },
        { value: 'identity', detail: 'No compression' },
    ],
    'accept-language': [
        { value: 'en-US,en;q=0.9', detail: 'English, US preferred' },
        { value: 'en-GB,en;q=0.9', detail: 'English, UK preferred' },
    ],
    authorization: [
        { value: 'Bearer {{api_token}}', detail: 'Bearer token from environment' },
        { value: 'Basic {{username}}:{{password}}', detail: 'Basic credentials template' },
    ],
    'cache-control': [
        { value: 'no-cache', detail: 'Force revalidation' },
        { value: 'no-store', detail: 'Disable caching' },
        { value: 'max-age=0', detail: 'Immediately stale' },
    ],
    connection: [
        { value: 'keep-alive', detail: 'Reuse the connection' },
        { value: 'close', detail: 'Close after the response' },
    ],
    'content-type': [
        { value: 'application/json', detail: 'JSON payload' },
        { value: 'application/x-www-form-urlencoded', detail: 'Form URL encoded payload' },
        { value: 'multipart/form-data', detail: 'Multipart form payload' },
        { value: 'text/plain', detail: 'Plain text payload' },
        { value: 'text/xml', detail: 'XML payload' },
    ],
    origin: [
        { value: '{{base_url}}', detail: 'Environment origin' },
    ],
    pragma: [
        { value: 'no-cache', detail: 'Legacy no-cache directive' },
    ],
    referer: [
        { value: '{{base_url}}/', detail: 'Environment referer' },
    ],
    'user-agent': [
        { value: 'Requii/{{app_version}}', detail: 'Custom app identifier' },
        { value: 'Mozilla/5.0', detail: 'Generic browser-style agent' },
    ],
    'x-requested-with': [
        { value: 'XMLHttpRequest', detail: 'AJAX-style request hint' },
    ],
};
export const ENV_AUTOCOMPLETE_MIN_LENGTH = 3;
export const PANE_STORAGE_KEY = 'requii-pane-sizes';
export const DEFAULT_PANE_SIZES = { left: 300, right: 320 };
export const LEFT_PANE_MIN_WIDTH = 250;
export const RIGHT_PANE_MIN_WIDTH = 260;
export const CENTER_PANE_MIN_WIDTH = 520;
export const SPLITTER_WIDTH = 10;
