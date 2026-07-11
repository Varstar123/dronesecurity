// Public landing page ("Eye of the City") — vanilla port of a GSAP/ScrollTrigger
// React component. Standalone: shares nothing with the portal (no theme picker, no
// socket, no auth); the only way out is the sign-in button, which goes to /login.
// The boot terminal stays in Russian for the aesthetic; the page itself is English.
// gsap + ScrollTrigger load as classic scripts in welcome.html, so they're on window
// by the time this deferred module runs.

// ---------- content ----------
const BOOT_SEQUENCE = [
  'ИНИЦИАЛИЗАЦИЯ СИСТЕМЫ...',
  'ЗАГРУЗКА ПРОТОКОЛА: ПАТРУЛЬ',
  'СВЯЗЬ С ЦЕНТРОМ УПРАВЛЕНИЯ: OK',
  'ИИ-ЗРЕНИЕ: CLAUDE VISION // АКТИВНО',
  'GPS: КОЖИКОДЕ 11.25°N 75.78°E',
  'ФЛОТ: 4 ДРОНА В ВОЗДУХЕ',
  'РЕЖИМ: НАБЛЮДЕНИЕ',
  'ДОСТУП РАЗРЕШЕН // ВХОД'
];

// The four stages of the system, in order: patrol → the city → watch → dispatch.
const IMAGES = [
  { src: 'https://images.unsplash.com/photo-1508614589041-895b88991e3e?q=80&w=1200&auto=format&fit=crop', title: 'PATROL' },   // drone + gimbal camera
  { src: 'https://images.unsplash.com/photo-1477959858617-67f85cf4f1df?q=80&w=1200&auto=format&fit=crop', title: 'CITY' },     // the aerial beat
  { src: 'https://images.unsplash.com/photo-1557597774-9d273605dfa9?q=80&w=1200&auto=format&fit=crop', title: 'WATCH' },       // surveillance
  { src: 'https://images.unsplash.com/photo-1449824913935-59a10b8d2000?q=80&w=1200&auto=format&fit=crop', title: 'DISPATCH' }  // response on the street
];

// The system's four real capabilities.
const FEATURES = [
  { title: 'DETECTION', description: 'Claude vision reads every captured frame and flags 17 incident types — fire, weapons, accidents, crowds — in seconds.' },
  { title: 'REVIEW', description: 'Drones are not infallible, so every alert reaches a duty officer: escalate to the main force, or dismiss and resume the patrol.' },
  { title: 'DISPATCH', description: 'Enter a location and the nearest drones are dispatched automatically to surround it.' },
  { title: 'LIVE FEED', description: 'Live camera feeds stream straight back to the control center over a real-time socket.' }
];

const $ = (id) => document.getElementById(id);
const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

gsap.registerPlugin(ScrollTrigger);

// ---------- boot ----------
buildGallery();
buildFeatures();
if (REDUCED) revealPage(); else runPreloader();

// ---------- build the data-driven sections ----------
function buildGallery() {
  $('gallery').innerHTML = IMAGES.map((img, i) => `
    <div class="sliced">
      <div class="sliced-box">
        <div class="slice slice-top"><img src="${img.src}" alt="" loading="lazy" /></div>
        <div class="slice slice-bottom"><img src="${img.src}" alt="" loading="lazy" /></div>
        <div class="cut"></div>
        <h2 class="slice-title">${img.title}</h2>
      </div>
      <div class="sliced-id">SYSTEM ID: 00${i + 1}</div>
    </div>`).join('');
}

function buildFeatures() {
  $('featuresGrid').innerHTML = FEATURES.map((f, i) => `
    <div class="feature">
      <h4 data-type-reveal>${f.title}</h4>
      <p data-type-reveal>${f.description}</p>
      <div class="feature-access" data-reveal-up data-delay="0.4">DIRECT ACCESS [0${i + 1}]</div>
    </div>`).join('');
}

// ---------- terminal preloader ----------
// Types the boot sequence out line by line, then "cuts" the overlay away.
function runPreloader() {
  document.body.classList.add('locked');
  const box = $('bootLines');
  const cursor = document.createElement('div');
  cursor.className = 'pre-cursor';
  cursor.textContent = '_';

  let delay = 0;
  BOOT_SEQUENCE.forEach((line, i) => {
    delay += Math.random() * 300 + 100; // uneven, human-ish typing speed
    setTimeout(() => {
      const row = document.createElement('div');
      row.className = 'pre-line';
      row.innerHTML = `<span class="n">&gt;0${i + 1}</span><span class="t"></span>`;
      row.querySelector('.t').textContent = line;
      box.insertBefore(row, cursor);
      box.scrollTop = box.scrollHeight;
    }, delay);
  });
  box.appendChild(cursor);

  setTimeout(() => {
    gsap.to('#preloader', {
      clipPath: 'polygon(0 0, 100% 0, 100% 0, 0 0)', // swipe up out of frame
      duration: 0.8,
      ease: 'power4.inOut',
      onComplete: () => {
        $('preloader').remove();
        revealPage();
      }
    });
  }, delay + 800);
}

// Fade the page in, then wire the scroll animations. Setting them up *after* the
// preloader means the hero reveal is actually seen instead of playing behind it.
function revealPage() {
  document.body.classList.remove('locked');
  $('content').classList.add('ready');
  if (REDUCED) return;
  initTypeReveals();
  initRevealUps();
  initSlicedParallax();
  ScrollTrigger.refresh();
}

// ---------- reveal primitives ----------
// Character-by-character blur-in, staggered.
function initTypeReveals() {
  document.querySelectorAll('[data-type-reveal]').forEach((el) => {
    const text = el.textContent;
    el.textContent = '';
    for (const ch of text) {
      const span = document.createElement('span');
      span.className = 'type-char';
      span.textContent = ch === ' ' ? ' ' : ch; // keep spaces from collapsing
      el.appendChild(span);
    }
    gsap.fromTo(el.querySelectorAll('.type-char'),
      { opacity: 0, y: 15, filter: 'blur(5px)' },
      {
        opacity: 1, y: 0, filter: 'blur(0px)',
        duration: 0.8, stagger: 0.02, ease: 'power3.out',
        scrollTrigger: { trigger: el, start: 'top 85%' }
      });
  });
}

// Whole-block fade/blur up.
function initRevealUps() {
  document.querySelectorAll('[data-reveal-up]').forEach((el) => {
    gsap.fromTo(el,
      { opacity: 0, y: 40, filter: 'blur(10px)' },
      {
        opacity: 1, y: 0, filter: 'blur(0px)',
        duration: 1.2, delay: parseFloat(el.dataset.delay) || 0, ease: 'power3.out',
        scrollTrigger: { trigger: el, start: 'top 85%' }
      });
  });
}

// The signature effect: as the section scrolls, the two halves of the image slide
// apart in opposite directions, so the diagonal seam reads as a sword cut.
function initSlicedParallax() {
  document.querySelectorAll('.sliced').forEach((el) => {
    const tl = gsap.timeline({
      scrollTrigger: { trigger: el, start: 'top bottom', end: 'bottom top', scrub: 0.5 }
    });
    tl.fromTo(el.querySelector('.slice-top'),
      { xPercent: 10, scale: 1.1 }, { xPercent: -10, scale: 1, ease: 'none' }, 0);
    tl.fromTo(el.querySelector('.slice-bottom'),
      { xPercent: -10, scale: 1.1 }, { xPercent: 10, scale: 1, ease: 'none' }, 0);
    tl.fromTo(el.querySelector('.slice-title'),
      { opacity: 0, scale: 1.5, filter: 'blur(10px)' },
      { opacity: 1, scale: 1, filter: 'blur(0px)', ease: 'power2.out', duration: 0.5 }, 0.2);
  });
}
