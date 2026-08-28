window.PRIVATE_OFFICE_CONFIG = {
  API_URL: 'https://private-office.sarkiamada.workers.dev',
  APP_NAME: 'Private Office',
  SIMPLE_UPLOAD_MB: 12,
  MAX_UPLOAD_GB: 5,
  MULTIPART_CHUNK_MB: 8
};

window.addEventListener('DOMContentLoaded', () => {
  const s = document.createElement('script');
  s.src = './file-controls.js?v=2';
  document.body.appendChild(s);
});
