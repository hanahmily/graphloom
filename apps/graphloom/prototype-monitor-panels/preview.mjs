// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

// Throwaway browser host. The renderer is injected ahead of this script by run.mjs.
(() => {
  const root = document.getElementById('graphloom-panel-prototype');
  const state = { panel: 'topology', scenario: 'running', selected: 'implement', fontSize: 13 };
  const surfaces = [...root.querySelectorAll('[data-layout]')];
  const measure = document.createElement('canvas').getContext('2d');
  let scheduled;
  const kinds = PANEL_KINDS;
  const nodeNames = [ ['spec','Spec'], ['diagnose','Diagnose'], ['implement','Implement'], ['verify','Verify'], ['deliver','Deliver'], ['arbitrate','Arbitrate'] ];

  function selectPanel(id) { state.panel = id; render(); }
  for (const surface of surfaces) {
    const nav = surface.querySelector('[data-panels]');
    const picker = surface.querySelector('[data-panel-select]');
    for (const { id, title } of kinds) {
      if (nav) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = title;
        button.dataset.panel = id;
        button.className = 'cursor-interaction';
        button.addEventListener('click', () => selectPanel(id));
        nav.append(button);
      }
      if (picker) picker.add(new Option(title, id));
    }
    picker?.addEventListener('change', () => selectPanel(picker.value));
    const scenario = surface.querySelector('[data-scenario]');
    scenario.addEventListener('change', () => { state.scenario = scenario.value; render(); });
    const node = surface.querySelector('[data-node]');
    for (const [id, name] of nodeNames) node.add(new Option(name, id));
    node.addEventListener('change', () => { state.selected = node.value; render(); });
  }

  function render() {
    root.style.setProperty('--gl-font', `${state.fontSize}px`);
    const snapshot = makeSnapshot(state.scenario);
    for (const surface of surfaces) {
      const pre = surface.querySelector('[data-frame]');
      const compact = surface.dataset.layout === 'compact';
      const style = getComputedStyle(pre);
      measure.font = `${state.fontSize}px ${style.fontFamily}`;
      const available = pre.clientWidth || Math.max(220, root.clientWidth - 64);
      const columns = Math.max(24, Math.min(compact ? 60 : 96, Math.floor(available / measure.measureText('M').width) - 1));
      const panel = renderPanel(state.panel, snapshot, { width: columns, selected: state.selected, compact });
      if (surface.dataset.layout === 'chat') pre.textContent = panel.text;
      else pre.innerHTML = panel.html;
      pre.setAttribute('aria-label', `${panel.title}. Sample ${state.scenario} run. ${state.selected} selected.`);
      surface.querySelector('[data-scenario]').value = state.scenario;
      surface.querySelector('[data-node]').value = state.selected;
      const picker = surface.querySelector('[data-panel-select]');
      if (picker) picker.value = state.panel;
      for (const button of surface.querySelectorAll('[data-panel]')) button.setAttribute('aria-pressed', String(button.dataset.panel === state.panel));
      const title = surface.querySelector('[data-panel-title]');
      if (title) title.textContent = panel.title;
      const requested = surface.querySelector('[data-requested-panel]');
      if (requested) requested.textContent = panel.title.toLowerCase();
      surface.querySelector('[data-summary]').textContent = `${snapshot.runId} · ${snapshot.status} · sample observation`;
      surface.querySelector('[data-observed]').textContent = `Observed ${snapshot.observedAt.slice(11, 19)} UTC`;
      const caption = surface.querySelector('[data-frame-caption]');
      if (caption) caption.textContent = `${columns} columns · ${state.selected} selected`;
    }
    root.dataset.panel = state.panel;
    root.dataset.scenario = state.scenario;
  }
  function schedule() { cancelAnimationFrame(scheduled); scheduled = requestAnimationFrame(render); }
  render();
  new ResizeObserver(schedule).observe(root);
  new MutationObserver(schedule).observe(root.querySelector('.viz-carousel'), { attributes: true, attributeFilter: ['hidden'], subtree: true });
  if (globalThis.Tweak) {
    const tweak = new Tweak({ container: root, onChange: schedule });
    tweak.addSlider(state, 'fontSize', { label: 'Panel text size', min: 11, max: 16, step: 1, unit: 'px' });
  }
})();
