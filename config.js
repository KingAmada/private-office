window.PRIVATE_OFFICE_CONFIG = {
  API_URL: 'https://private-office.sarkiamada.workers.dev',
  APP_NAME: 'Private Office',
  SIMPLE_UPLOAD_MB: 12,
  MAX_UPLOAD_GB: 5,
  MULTIPART_CHUNK_MB: 8
};

window.addEventListener('DOMContentLoaded', () => {
  const polish = document.createElement('link');
  polish.rel = 'stylesheet';
  polish.href = './ui-polish.css?v=1';
  document.head.appendChild(polish);

  const s = document.createElement('script');
  s.src = './file-controls.js?v=2';
  document.body.appendChild(s);
});
