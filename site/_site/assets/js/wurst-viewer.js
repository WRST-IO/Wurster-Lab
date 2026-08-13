import '/assets/wurster/wurster-embed.js';

const $ = (selector) => document.querySelector(selector);
const dropzone = $('#viewerDropzone');
const input = $('#viewerFile');
const choose = $('#viewerChoose');
const close = $('#viewerClose');
const info = $('#viewerInfo');
const stageWrap = $('#viewerStageWrap');
const stage = $('#viewerStage');
const status = $('#viewerStatus');
const name = $('#viewerName');
const protection = $('#viewerProtection');
const identity = $('#viewerIdentity');

function humanProtection(manifest) {
  const mode = manifest?.application?.protection || 'public';
  if (mode === 'sealed') return '🔐 fully sealed / WurstKey';
  if (mode === 'partial') return '🔑 partial / WurstKey';
  return '✓ public application';
}

function humanIdentity(signature) {
  if (signature?.status === 'signed') {
    const trust = signature.certificateTrust;
    const publisher = signature.publisher?.domain || signature.publisher?.email || signature.publisher?.label || String(signature.publisher?.fingerprint || '').slice(0, 12);
    if (trust?.status === 'verified') return `✓ ${publisher} · ${trust.root?.authority || 'trusted Authority'}`;
    if (trust?.status === 'revoked-publisher' || trust?.status === 'revoked-issuer') return `⚠ revoked · ${publisher}`;
    if (trust?.status === 'invalid') return `⚠ certificate invalid · ${publisher}`;
    return publisher ? `✓ signed · ${publisher}` : '✓ valid package signature';
  }
  if (signature?.status === 'invalid') return '⚠ invalid signature';
  return 'unsigned Wurst';
}

async function openFile(file) {
  if (!file) return;
  if (!/\.(wurst|wrst)$/i.test(file.name)) {
    status.textContent = 'That does not look like a .wurst or .wrst file.';
    return;
  }
  status.textContent = `Opening ${file.name}…`;
  name.textContent = file.name;
  protection.textContent = 'inspecting…';
  identity.textContent = 'inspecting…';
  info.hidden = false;
  stageWrap.hidden = false;
  try {
    await stage.open(file);
  } catch (error) {
    status.textContent = error?.message || String(error);
  }
}

stage.addEventListener('wurst-ready', (event) => {
  const { manifest, signature } = event.detail || {};
  name.textContent = manifest?.name || name.textContent;
  protection.textContent = humanProtection(manifest);
  identity.textContent = humanIdentity(signature);
  status.textContent = manifest?.application?.protection === 'sealed'
    ? 'Protected Wurst unlocked and opened in Wurster Web.'
    : 'Wurst opened in Wurster Web.';
});
stage.addEventListener('wurst-error', (event) => { status.textContent = event.detail?.error || 'The Wurst could not be opened.'; });

choose.addEventListener('click', () => input.click());
input.addEventListener('change', () => void openFile(input.files?.[0]));
dropzone.addEventListener('click', (event) => { if (event.target !== choose) input.click(); });
dropzone.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); input.click(); } });
for (const type of ['dragenter', 'dragover']) dropzone.addEventListener(type, (event) => { event.preventDefault(); dropzone.classList.add('dragover'); });
for (const type of ['dragleave', 'drop']) dropzone.addEventListener(type, (event) => { event.preventDefault(); dropzone.classList.remove('dragover'); });
dropzone.addEventListener('drop', (event) => void openFile(event.dataTransfer?.files?.[0]));
close.addEventListener('click', () => {
  stage.remove();
  const fresh = document.createElement('wurst-embed'); fresh.id = 'viewerStage'; fresh.title = 'Wurster online viewer';
  stageWrap.replaceChildren(fresh);
  location.reload();
});
