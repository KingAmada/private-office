window.PRIVATE_OFFICE_CONFIG = {
  API_URL: 'https://private-office.sarkiamada.workers.dev',
  APP_NAME: 'Private Office',
  MAX_UPLOAD_MB: 12
};

window.addEventListener('DOMContentLoaded', () => {
  const s = document.createElement('script');
  s.src = './file-controls.js?v=2';
  document.body.appendChild(s);
});
