window.PRIVATE_OFFICE_CONFIG = {
  APP_NAME: 'Private Office',
  GOOGLE_CLIENT_ID: '785030760124-2f54hqcimk7t4kptp8ku1se21hs9f528.apps.googleusercontent.com',
  AI_GATEWAY_URL: 'https://private-office.sarkiamada.workers.dev',
  ROOT_FOLDER: 'Private Office',
  MAX_AI_FILE_MB: 8,
  SYNC_BATCH_SIZE: 8
};

/*
 * Session bridge
 * - keeps a short-lived Drive access token in sessionStorage so a page refresh
 *   does not force another Google consent flow;
 * - auto-resumes the app while the Google ID token and Drive token are valid;
 * - changes repeated `prompt: consent` calls to the normal empty prompt after
 *   the user has already granted Drive access.
 *
 * Tokens are intentionally session-scoped, not permanently stored.
 */
(() => {
  const DRIVE_TOKEN_KEY = 'po_drive_token_v2';
  const DRIVE_GRANTED_KEY = 'po_drive_granted_v2';
  let pageGooglePatch = null;

  function readJson(key) {
    try { return JSON.parse(sessionStorage.getItem(key) || 'null'); }
    catch { return null; }
  }

  function validDriveToken() {
    const x = readJson(DRIVE_TOKEN_KEY);
    if (!x?.access_token || !x?.expiresAt) return null;
    if (Number(x.expiresAt) <= Date.now() + 60_000) {
      sessionStorage.removeItem(DRIVE_TOKEN_KEY);
      return null;
    }
    return x;
  }

  function jwtValid(token) {
    try {
      const p = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      const padded = p + '='.repeat((4 - p.length % 4) % 4);
      const payload = JSON.parse(atob(padded));
      return Number(payload.exp || 0) * 1000 > Date.now() + 30_000;
    } catch {
      return false;
    }
  }

  function saveToken(r) {
    if (!r?.access_token) return;
    const seconds = Math.max(60, Number(r.expires_in || 3600));
    sessionStorage.setItem(DRIVE_TOKEN_KEY, JSON.stringify({
      access_token: r.access_token,
      expiresAt: Date.now() + seconds * 1000,
      scope: r.scope || 'https://www.googleapis.com/auth/drive',
      token_type: r.token_type || 'Bearer'
    }));
    localStorage.setItem(DRIVE_GRANTED_KEY, '1');
  }

  function installSessionPatch() {
    if (!window.google?.accounts) return;

    const id = google.accounts.id;
    if (id?.initialize && !id.__privateOfficeSessionPatched) {
      const originalInitialize = id.initialize.bind(id);
      id.initialize = function (options = {}) {
        const callback = options.callback;
        const result = originalInitialize({ ...options, use_fedcm_for_button: true });

        const oldIdToken = sessionStorage.getItem('po_id_token');
        const cachedDrive = validDriveToken();
        if (
          typeof callback === 'function' &&
          oldIdToken && jwtValid(oldIdToken) && cachedDrive &&
          !window.__privateOfficeAutoResumeScheduled
        ) {
          window.__privateOfficeAutoResumeScheduled = true;
          setTimeout(() => callback({ credential: oldIdToken, select_by: 'auto_resume' }), 80);
        }
        return result;
      };
      id.__privateOfficeSessionPatched = true;
    }

    const oauth = google.accounts.oauth2;
    if (oauth?.initTokenClient && !oauth.__privateOfficeSessionPatched) {
      const originalInitTokenClient = oauth.initTokenClient.bind(oauth);
      oauth.initTokenClient = function (options = {}) {
        const appCallback = options.callback;
        const scopes = new Set(String(options.scope || '').split(/\s+/).filter(Boolean));
        scopes.delete('https://www.googleapis.com/auth/drive.readonly');
        scopes.delete('https://www.googleapis.com/auth/drive.file');
        scopes.add('https://www.googleapis.com/auth/drive');

        const wrappedCallback = response => {
          if (response?.access_token) saveToken(response);
          if (typeof appCallback === 'function') appCallback(response);
        };

        const client = originalInitTokenClient({
          ...options,
          scope: [...scopes].join(' '),
          callback: wrappedCallback
        });

        const originalRequest = client.requestAccessToken.bind(client);
        client.requestAccessToken = function (override = {}) {
          const cached = validDriveToken();
          if (cached) {
            queueMicrotask(() => wrappedCallback({
              access_token: cached.access_token,
              expires_in: Math.max(1, Math.floor((cached.expiresAt - Date.now()) / 1000)),
              scope: cached.scope,
              token_type: cached.token_type,
              prompt: ''
            }));
            return;
          }

          const next = { ...override };
          if (next.prompt === 'consent' && localStorage.getItem(DRIVE_GRANTED_KEY) === '1') {
            next.prompt = '';
          }
          originalRequest(next);
        };
        return client;
      };

      if (oauth.revoke && !oauth.__privateOfficeRevokePatched) {
        const originalRevoke = oauth.revoke.bind(oauth);
        oauth.revoke = function (...args) {
          sessionStorage.removeItem(DRIVE_TOKEN_KEY);
          localStorage.removeItem(DRIVE_GRANTED_KEY);
          return originalRevoke(...args);
        };
        oauth.__privateOfficeRevokePatched = true;
      }

      oauth.__privateOfficeSessionPatched = true;
    }
  }

  /* The page defines this hook after config.js. Capture that assignment and
     run the page's normal Google patches first, then add session persistence. */
  try {
    Object.defineProperty(window, '__poEnableGooglePatches', {
      configurable: true,
      get() {
        return function () {
          if (typeof pageGooglePatch === 'function') pageGooglePatch();
          installSessionPatch();
        };
      },
      set(fn) { pageGooglePatch = fn; }
    });
  } catch {}

  window.PrivateOfficeSession = {
    getDriveToken: validDriveToken,
    clear() {
      sessionStorage.removeItem(DRIVE_TOKEN_KEY);
      sessionStorage.removeItem('po_id_token');
      localStorage.removeItem(DRIVE_GRANTED_KEY);
    }
  };

  if (document.querySelector('script[data-private-office-mobile]')) return;
  const script = document.createElement('script');
  script.src = './mobile.js';
  script.defer = true;
  script.dataset.privateOfficeMobile = '1';
  document.head.appendChild(script);
})();
