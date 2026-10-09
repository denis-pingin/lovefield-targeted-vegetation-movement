const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character =>
  ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[character]));
const regionName = {A: 'Region A', B: 'Region B', background: 'Reference'};
const pointsFor = (regions, name) => Array.isArray(regions?.[name]) ? regions[name] : regions?.[name]?.points;

/** Place presentation labels in CSS pixels without changing retained region points. */
export function placeRegionLabel({points, imageSize, displaySize, labelSize, occupied = []}) {
  const {width, height} = displaySize, labelWidth = labelSize.width, labelHeight = labelSize.height;
  if (!points?.length || width < labelWidth || height < labelHeight || width <= 0 || height <= 0) {
    return {left: 0, top: 0, external: true};
  }
  const horizontal = points.map(point => point[0] * width / imageSize.width);
  const vertical = points.map(point => point[1] * height / imageSize.height);
  const left = Math.min(...horizontal), right = Math.max(...horizontal);
  const top = Math.min(...vertical), bottom = Math.max(...vertical), gap = 4;
  const corners = (left + right) / 2 <= width / 2 ? [left, right - labelWidth] : [right - labelWidth, left];
  const candidates = [];
  if (top >= labelHeight + gap) corners.forEach(position => candidates.push([position, top - labelHeight - gap]));
  const sides = [[left - labelWidth - gap, top], [right + gap, top]];
  candidates.push(...((left + right) / 2 <= width / 2 ? sides : sides.reverse()));
  corners.forEach(position => candidates.push([position, top + gap]));
  corners.forEach(position => candidates.push([position, bottom + gap]));
  for (const [candidateLeft, candidateTop] of candidates) {
    const box = {left: Math.max(0, Math.min(width - labelWidth, candidateLeft)),
      top: Math.max(0, Math.min(height - labelHeight, candidateTop))};
    if (occupied.some(other => box.left < other.left + other.width + gap
      && box.left + labelWidth + gap > other.left && box.top < other.top + other.height + gap
      && box.top + labelHeight + gap > other.top)) continue;
    return {...box, external: false};
  }
  return {left: 0, top: 0, external: true};
}

export function renderPublicFigure({imageUrl, imageSize, regions, caption, alt, originalUrl, previewUrl, previewWidth, enlarged = false}) {
  const data = {imageUrl, imageSize, regions, caption, alt, originalUrl, previewUrl, previewWidth};
  const available = Object.keys(regionName).filter(name => pointsFor(regions, name)?.length);
  const missing = Object.keys(regionName).filter(name => !available.includes(name)).map(name => regionName[name]);
  const polygons = available.map(name => `<polygon data-region="${name}" points="${escapeHtml(pointsFor(regions, name).map(point => point.join(',')).join(' '))}"/>`).join('');
  const labels = available.map(name => `<span class="public-region-label" data-region="${name}" data-region-label="${name}">${regionName[name]}</span>`).join('');
  const key = available.map(name => `<span class="public-region-label" data-region="${name}" data-region-key="${name}" hidden>${regionName[name]}</span>`).join('');
  const image = `<img data-figure-image src="${escapeHtml(imageUrl)}"${previewUrl && !enlarged ? ` srcset="${escapeHtml(previewUrl)} ${previewWidth}w, ${escapeHtml(imageUrl)} ${imageSize.width}w" sizes="(max-width: 72rem) 100vw, 72rem"` : ''} width="${imageSize.width}" height="${imageSize.height}" alt="${escapeHtml(alt)}" decoding="async">`;
  return `<figure class="public-figure" data-public-figure="${escapeHtml(JSON.stringify(data))}"><div class="public-figure-frame" data-figure-frame>`
    + (enlarged ? image : `<button type="button" class="public-figure-image" data-figure-open aria-label="Enlarge image">${image}</button>`)
    + `<div class="public-figure-overlay" aria-hidden="true"><svg viewBox="0 0 ${imageSize.width} ${imageSize.height}" preserveAspectRatio="xMidYMid meet">${polygons}</svg>${labels}</div></div>`
    + `<div class="public-figure-key" data-figure-key hidden>${key}</div><p class="site-supporting-copy" role="status" data-figure-loading>Loading image.</p>`
    + '<div class="public-figure-error" data-figure-error hidden><p role="alert">This image could not be loaded. Check your connection, then retry.</p><button type="button" class="site-control" data-figure-retry>Retry</button></div>'
    + `<figcaption>${escapeHtml(caption)}</figcaption>`
    + (missing.length ? `<p class="site-supporting-copy">${escapeHtml(missing.join(' and '))} ${missing.length === 1 ? 'is' : 'are'} unavailable for this image.</p>` : '')
    + `<div class="site-link-group public-figure-actions">${enlarged ? '' : '<button type="button" class="site-control" data-figure-open>Enlarge image</button>'}${originalUrl ? `<a href="${escapeHtml(originalUrl)}" download>Download original setup PNG</a>` : ''}</div></figure>`;
}

export function mountPublicFigures(root, {document = globalThis.document, ResizeObserver = globalThis.ResizeObserver} = {}) {
  const figures = [...root.querySelectorAll('[data-public-figure]')];
  if (!figures.length) return {dispose() {}};
  const logger = document.defaultView?.console ?? console;
  let viewer = null, opener = null;
  const layout = figure => {
    const data = JSON.parse(figure.dataset.publicFigure), frame = figure.querySelector('[data-figure-frame]');
    const displaySize = frame.getBoundingClientRect(), occupied = [];
    const external = new Set();
    for (const label of figure.querySelectorAll('[data-region-label]')) {
      label.hidden = false;
      const labelSize = label.getBoundingClientRect();
      const placed = placeRegionLabel({points: pointsFor(data.regions, label.dataset.regionLabel),
        imageSize: data.imageSize, displaySize, labelSize, occupied});
      label.hidden = placed.external;
      if (placed.external) external.add(label.dataset.regionLabel);
      else {
        label.style.left = `${placed.left}px`; label.style.top = `${placed.top}px`;
        occupied.push({...placed, width: labelSize.width, height: labelSize.height});
      }
    }
    figure.querySelector('[data-figure-key]').hidden = external.size === 0;
    for (const item of figure.querySelectorAll('[data-region-key]')) item.hidden = !external.has(item.dataset.regionKey);
  };
  const observer = ResizeObserver ? new ResizeObserver(entries => entries.forEach(entry => {
    const figure = entry.target.closest('[data-public-figure]'); if (figure) layout(figure);
  })) : null;
  if (!observer) logger.warn('Tree public image resize observation is unavailable; labels use initial displayed dimensions.');
  const ready = figure => {
    figure.querySelector('[data-figure-loading]').hidden = true;
    figure.querySelector('[data-figure-error]').hidden = true;
    layout(figure);
  };
  const register = figure => {
    observer?.observe(figure.querySelector('[data-figure-frame]'));
    const image = figure.querySelector('[data-figure-image]');
    if (image.complete && image.naturalWidth > 0) ready(figure);
    else layout(figure);
  };
  const removeViewer = (restoreFocus = false) => {
    if (!viewer) return;
    for (const figure of viewer.querySelectorAll('[data-public-figure]')) observer?.unobserve(figure.querySelector('[data-figure-frame]'));
    viewer.removeEventListener('close', closed); viewer.removeEventListener('cancel', canceled);
    viewer.remove(); viewer = null;
    if (restoreFocus && opener?.isConnected) opener.focus();
    opener = null;
  };
  const closed = () => removeViewer(true);
  const canceled = event => {event.preventDefault(); viewer?.close();};
  const click = event => {
    if (event.target.closest('[data-figure-close]')) {viewer?.close(); return;}
    const retry = event.target.closest('[data-figure-retry]');
    if (retry) {
      const figure = retry.closest('[data-public-figure]');
      figure.querySelector('[data-figure-error]').hidden = true;
      figure.querySelector('[data-figure-loading]').hidden = false;
      figure.querySelector('[data-figure-image]').src = JSON.parse(figure.dataset.publicFigure).imageUrl;
      return;
    }
    const control = event.target.closest('[data-figure-open]');
    if (!control) return;
    const figure = control.closest('[data-public-figure]');
    removeViewer(); opener = control;
    viewer = document.createElement('dialog'); viewer.className = 'public-figure-viewer';
    viewer.setAttribute('aria-label', 'Enlarged study image');
    viewer.innerHTML = '<div class="public-figure-viewer-controls"><button type="button" class="site-control" data-figure-close>Close image</button></div>'
      + renderPublicFigure({...JSON.parse(figure.dataset.publicFigure), enlarged: true});
    viewer.addEventListener('close', closed); viewer.addEventListener('cancel', canceled);
    root.append(viewer); viewer.showModal();
    register(viewer.querySelector('[data-public-figure]'));
    viewer.querySelector('[data-figure-close]').focus();
  };
  const imageEvent = event => {
    if (event.target.dataset?.figureImage === undefined) return;
    const figure = event.target.closest('[data-public-figure]');
    if (!figure) return;
    if (event.type === 'error') {
      figure.querySelector('[data-figure-loading]').hidden = true;
      figure.querySelector('[data-figure-error]').hidden = false;
      logger.warn('Tree public image failed to load; Retry and the available original download remain visible.',
        {imageUrl: JSON.parse(figure.dataset.publicFigure).imageUrl});
    } else ready(figure);
  };
  root.addEventListener('click', click);
  root.addEventListener('load', imageEvent, true); root.addEventListener('error', imageEvent, true);
  figures.forEach(register);
  return {dispose() {
    removeViewer(); observer?.disconnect(); root.removeEventListener('click', click);
    root.removeEventListener('load', imageEvent, true); root.removeEventListener('error', imageEvent, true);
  }};
}
