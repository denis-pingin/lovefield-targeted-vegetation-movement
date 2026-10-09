import {labPageUrl} from './study-paths.mjs';
import {availableStudies, publicStudyIdentity, studyPages} from './public-study-content.mjs';
export {studyPages} from './public-study-content.mjs';

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character =>
  ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[character]));
const menuPage = page => page === 'recording' ? 'recordings' : ['protocol', 'analysis'].includes(page) ? 'methods' : page;
const isStudyPage = page => studyPages.some(([key]) => key === menuPage(page));
const initiallyExpanded = (study, page) => study.slug === publicStudyIdentity.slug && isStudyPage(page)
  || page === 'index' && availableStudies.length === 1;

export function renderStudyNavigation({page = 'about', publicationId} = {}) {
  return `<nav class="site-section-menu__navigation" aria-label="Lab pages"><div class="site-section-menu__group"><div class="site-section-menu__row"><a class="site-control site-control--menu-item" data-lab-page="index" href="${escapeHtml(labPageUrl('index', publicationId))}"${page === 'index' ? ' aria-current="page"' : ''}><strong>Lovefield Lab</strong></a></div></div>`
    + availableStudies.map(study => {
      const expanded = initiallyExpanded(study, page), childrenId = `study-navigation-${study.slug}`;
      return `<div class="site-section-menu__group"><div class="site-section-menu__row site-section-menu__row--expandable"><a class="site-control site-control--menu-item" data-study-overview="${study.slug}" href="${escapeHtml(study.url('about', publicationId))}"><strong>${escapeHtml(study.name)}</strong></a>`
        + `<button class="site-control site-control--menu site-section-menu__toggle" type="button" aria-controls="${childrenId}" aria-expanded="${expanded}" aria-label="${expanded ? 'Collapse' : 'Expand'} ${escapeHtml(study.name)}" data-expand-label="Expand ${escapeHtml(study.name)}" data-collapse-label="Collapse ${escapeHtml(study.name)}" data-study-toggle="${study.slug}"><svg aria-hidden="true" data-menu-icon-closed viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"></path></svg><svg aria-hidden="true" data-menu-icon-open viewBox="0 0 24 24"><path d="m6 15 6-6 6 6"></path></svg></button></div>`
        + `<ul class="site-section-menu__children" id="${childrenId}"${expanded ? '' : ' hidden'}>${study.pages.map(([key, label]) => `<li><a class="site-control site-control--menu-item" data-study-slug="${study.slug}" data-study-page="${key}" href="${escapeHtml(study.url(key, publicationId))}"${study.slug === publicStudyIdentity.slug && menuPage(page) === key ? ' aria-current="page"' : ''}><strong>${escapeHtml(label)}</strong></a></li>`).join('')}</ul></div>`;
    }).join('')
    + '<div class="site-section-menu__group site-section-menu__group--global"><a class="site-control site-control--menu-item" href="https://sourceof.love/en"><strong>Lovefield Project</strong></a></div></nav>';
}

/** Standalone Lab adaptation of the canonical website's menu and focus behavior. */
export function mountStudyNavigation({document, window}) {
  const trigger = document.getElementById('study-menu-trigger'), overlay = document.getElementById('study-menu');
  const home = document.getElementById('study-home'), identityArea = document.getElementById('study-identity-label');
  const backgrounds = [...document.querySelectorAll('[data-menu-background]')];
  let scrollPosition = null, renderedPage = null;
  const visibleControls = () => [...overlay.querySelectorAll('a[href], button')].filter(control => !control.closest('[hidden]'));
  function expand(button, expanded) {
    button.setAttribute('aria-expanded', String(expanded));
    button.setAttribute('aria-label', expanded ? button.dataset.collapseLabel : button.dataset.expandLabel);
    document.getElementById(button.getAttribute('aria-controls')).hidden = !expanded;
  }
  const setTriggerState = expanded => {
    trigger.setAttribute('aria-expanded', String(expanded));
    trigger.setAttribute('aria-label', expanded ? trigger.dataset.closeLabel : trigger.dataset.openLabel);
  };
  function close({dismiss = true} = {}) {
    if (!scrollPosition) return;
    overlay.hidden = true;
    setTriggerState(false);
    backgrounds.forEach(background => { background.inert = false; });
    document.documentElement.classList.remove('site-menu-open');
    if (dismiss) {
      window.scrollTo({...scrollPosition, behavior: 'auto'});
      trigger.focus({preventScroll: true});
    }
    scrollPosition = null;
  }
  function toggle() {
    if (scrollPosition) { close(); return; }
    scrollPosition = {left: window.scrollX, top: window.scrollY};
    overlay.hidden = false;
    setTriggerState(true);
    backgrounds.forEach(background => { background.inert = true; });
    document.documentElement.classList.add('site-menu-open');
    visibleControls()[0]?.focus({preventScroll: true});
  }
  function keydown(event) {
    if (!scrollPosition) return;
    if (event.key === 'Escape') { event.preventDefault(); close(); return; }
    if (event.key !== 'Tab') return;
    const focusable = [trigger, ...visibleControls()];
    const index = focusable.indexOf(document.activeElement);
    const next = index < 0 ? event.shiftKey ? focusable.length - 1 : 0
      : event.shiftKey && index === 0 ? focusable.length - 1
        : !event.shiftKey && index === focusable.length - 1 ? 0 : null;
    if (next !== null) { event.preventDefault(); focusable[next].focus({preventScroll: true}); }
  }
  function navigate(event) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const button = event.target.closest('[data-study-toggle]');
    if (button) { expand(button, button.getAttribute('aria-expanded') !== 'true'); return; }
    if (event.target.closest('a[href]')) close({dismiss: false});
  }
  trigger.addEventListener('click', toggle);
  overlay.addEventListener('click', navigate);
  document.addEventListener('keydown', keydown);
  return {
    update({page, publicationId}) {
      document.body.dataset.studyPage = page;
      identityArea.textContent = 'Lab';
      home.setAttribute('aria-label', 'Lovefield Lab');
      home.setAttribute('href', labPageUrl('index', publicationId));
      if (renderedPage === null) overlay.innerHTML = renderStudyNavigation({page, publicationId});
      for (const link of overlay.querySelectorAll('[data-lab-page]')) {
        link.setAttribute('href', labPageUrl(link.dataset.labPage, publicationId));
        if (page === link.dataset.labPage) link.setAttribute('aria-current', 'page');
        else link.removeAttribute('aria-current');
      }
      for (const link of overlay.querySelectorAll('[data-study-page]')) {
        const study = availableStudies.find(item => item.slug === link.dataset.studySlug);
        link.setAttribute('href', study.url(link.dataset.studyPage, publicationId));
        if (study.slug === publicStudyIdentity.slug && link.dataset.studyPage === menuPage(page)) link.setAttribute('aria-current', 'page');
        else link.removeAttribute('aria-current');
      }
      for (const link of overlay.querySelectorAll('[data-study-overview]')) {
        const study = availableStudies.find(item => item.slug === link.dataset.studyOverview);
        link.setAttribute('href', study.url('about', publicationId));
      }
      if (renderedPage !== page) for (const button of overlay.querySelectorAll('[data-study-toggle]')) {
        expand(button, initiallyExpanded(availableStudies.find(study => study.slug === button.dataset.studyToggle), page));
      }
      renderedPage = page;
    },
    dispose() {
      close();
      trigger.removeEventListener('click', toggle);
      overlay.removeEventListener('click', navigate);
      document.removeEventListener('keydown', keydown);
    },
  };
}
