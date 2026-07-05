// ASCII glitch-ripple text effect — a dependency-free port of the React
// "AsciiGlitchRipple" component, adapted for this vanilla-JS police portal.
//
// attachAsciiRipple(el, opts) turns el's text into an interactive glitch field:
// moving the pointer across it sends a ripple out from the cursor that scrambles
// characters through an ASCII / box-drawing set before they settle back to the
// original text. With { auto:true } it also emits a gentle self-running ripple so
// the effect is visible without a hover — used for the "Drones are monitoring…"
// and "Nothing reviewed yet." empty states on the alerts panel.
//
// Pure DOM + requestAnimationFrame, no build step. Honours prefers-reduced-motion.

const WAVE_THRESH = 3; // within this many chars of the wave edge -> scramble
const CHAR_MULT = 3;   // spatial phase of the scramble cycle
const ANIM_STEP = 40;  // ms per scramble-character step
const WAVE_BUF = 5;    // extra radius so the wave clears both ends of the text

const DEFAULT_CHARS = '.,·-─~+:;=*π┐┌┘┴┬╗╔╝╚╬╠╣╩╦║░▒▓█▄▀▌▐■!?&#$@0123456789*';

const reducedMotion =
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function attachAsciiRipple(el, opts = {}) {
  if (!el) return () => {};
  // Idempotent: never wire the same node twice (renderAlerts creates fresh nodes,
  // but this guards accidental double-attach).
  if (el.dataset.rippleOn === '1') return () => {};

  const origTxt = (el.textContent || '').trim();
  // Accessibility path: leave the text static, animate nothing.
  if (reducedMotion || origTxt.length === 0) return () => {};

  el.dataset.rippleOn = '1';
  el.textContent = origTxt;

  // Accessibility: the visible node constantly rewrites its text, so its
  // accessible name would be mid-scramble glyphs. Hide it from assistive tech and
  // keep a static, screen-reader-only copy of the real message right beside it.
  el.setAttribute('aria-hidden', 'true');
  const srTwin = document.createElement('span');
  srTwin.className = 'sr-only';
  srTwin.textContent = origTxt;
  el.insertAdjacentElement('afterend', srTwin);

  const cfg = {
    dur: opts.dur ?? 1000,
    chars: opts.chars ?? DEFAULT_CHARS,
    preserveSpaces: opts.preserveSpaces ?? true,
    spread: opts.spread ?? 1.0,
    auto: opts.auto ?? false,
    autoEvery: opts.autoEvery ?? 2600, // ms between self-running ripples
  };

  const origChars = origTxt.split('');
  const len = origChars.length;

  let waves = []; // { startPos, startTime }
  let animId = null;
  let autoId = null;
  let isHover = false;
  let cursorPos = 0;
  let autoSweep = 0; // walks the auto ripple across the text

  const now = () => Date.now();

  function calcWaveEffect(charIdx, t) {
    let shouldAnim = false;
    let ch = origChars[charIdx];
    for (const w of waves) {
      const age = t - w.startTime;
      const prog = Math.min(age / cfg.dur, 1);
      const dist = Math.abs(charIdx - w.startPos);
      const maxDist = Math.max(w.startPos, len - w.startPos - 1);
      const rad = (prog * (maxDist + WAVE_BUF)) / cfg.spread;
      if (dist <= rad) {
        shouldAnim = true;
        const intens = Math.max(0, rad - dist);
        if (intens <= WAVE_THRESH && intens > 0) {
          const index = (dist * CHAR_MULT + Math.floor(age / ANIM_STEP)) % cfg.chars.length;
          ch = cfg.chars[index];
        }
      }
    }
    return { shouldAnim, ch };
  }

  function scrambled(t) {
    let out = '';
    for (let i = 0; i < len; i++) {
      const c = origChars[i];
      if (cfg.preserveSpaces && c === ' ') {
        out += ' ';
        continue;
      }
      const r = calcWaveEffect(i, t);
      out += r.shouldAnim ? r.ch : c;
    }
    return out;
  }

  function stop() {
    el.textContent = origTxt;
    el.classList.remove('as');
    if (animId) {
      cancelAnimationFrame(animId);
      animId = null;
    }
  }

  function frame() {
    const t = now();
    waves = waves.filter((w) => t - w.startTime < cfg.dur);
    if (waves.length === 0) {
      stop();
      return;
    }
    el.textContent = scrambled(t);
    animId = requestAnimationFrame(frame);
  }

  function startWave(pos) {
    if (len === 0) return;
    waves.push({ startPos: Math.max(0, Math.min(pos, len - 1)), startTime: now() });
    if (!animId) {
      el.classList.add('as');
      animId = requestAnimationFrame(frame);
    }
  }

  function posFromEvent(e) {
    const rect = el.getBoundingClientRect();
    if (!rect.width) return 0;
    const x = e.clientX - rect.left;
    return Math.max(0, Math.min(Math.round((x / rect.width) * len), len - 1));
  }

  const onEnter = (e) => {
    isHover = true;
    cursorPos = posFromEvent(e);
    startWave(cursorPos);
  };
  const onMove = (e) => {
    if (!isHover) return;
    const p = posFromEvent(e);
    if (p !== cursorPos) {
      cursorPos = p;
      startWave(cursorPos);
    }
  };
  const onLeave = () => {
    isHover = false;
  };

  el.addEventListener('mouseenter', onEnter);
  el.addEventListener('mousemove', onMove);
  el.addEventListener('mouseleave', onLeave);

  // Self-running ripple so the empty state shimmers without a hover.
  if (cfg.auto) {
    // Visible = document foregrounded AND the node is actually laid out. A hidden
    // tab uses .panel{display:none}, which keeps the node connected but gives it no
    // offsetParent — so this pauses the ripple instead of churning off-screen.
    const visible = () => !document.hidden && el.offsetParent !== null;
    if (visible()) startWave(Math.floor(len / 2)); // gentle opening ripple from the centre
    const stepBy = Math.max(3, Math.floor(len / 4));
    autoId = setInterval(() => {
      // Once renderAlerts() replaces this node, isConnected goes false: stop the
      // timer so detached nodes aren't animated and can be garbage-collected.
      if (!el.isConnected) {
        clearInterval(autoId);
        autoId = null;
        return;
      }
      if (isHover || !visible()) return; // skip while hovered, hidden, or off-screen
      autoSweep = (autoSweep + stepBy) % len;
      startWave(autoSweep);
    }, cfg.autoEvery);
  }

  return function cleanup() {
    el.removeEventListener('mouseenter', onEnter);
    el.removeEventListener('mousemove', onMove);
    el.removeEventListener('mouseleave', onLeave);
    if (autoId) {
      clearInterval(autoId);
      autoId = null;
    }
    if (animId) {
      cancelAnimationFrame(animId);
      animId = null;
    }
    el.removeAttribute('aria-hidden');
    srTwin.remove();
    delete el.dataset.rippleOn;
  };
}

export default attachAsciiRipple;
