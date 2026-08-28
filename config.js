window.PRIVATE_OFFICE_CONFIG = {
  APP_NAME: 'Private Office',
  GOOGLE_CLIENT_ID: '785030760124-2f54hqcimk7t4kptp8ku1se21hs9f528.apps.googleusercontent.com',
  AI_GATEWAY_URL: 'https://private-office.sarkiamada.workers.dev',
  ROOT_FOLDER: 'Private Office',
  MAX_AI_FILE_MB: 8,
  SYNC_BATCH_SIZE: 8
};

(() => {
  if (document.querySelector('script[data-private-office-mobile]')) return;
  const script = document.createElement('script');
  script.src = './mobile.js';
  script.defer = true;
  script.dataset.privateOfficeMobile = '1';
  document.head.appendChild(script);
})();
