// Progressive enhancement for the top nav: wraps the links in a collapsible container
// and injects a hamburger toggle. On desktop the toggle is hidden via CSS and the nav
// looks unchanged; on small screens the links collapse behind the hamburger.
(function () {
  var nav = document.querySelector('.nav');
  if (!nav) return;

  var links = Array.prototype.slice.call(nav.querySelectorAll('a'));
  if (!links.length) return;

  var wrap = document.createElement('div');
  wrap.className = 'nav-links';
  links.forEach(function (a) { wrap.appendChild(a); });

  var btn = document.createElement('button');
  btn.className = 'nav-toggle';
  btn.type = 'button';
  btn.setAttribute('aria-label', 'Toggle navigation');
  btn.setAttribute('aria-expanded', 'false');
  btn.innerHTML = '&#9776;'; // ☰

  var logo = nav.querySelector('.nav-logo');
  if (logo && logo.nextSibling) {
    nav.insertBefore(btn, logo.nextSibling);
  } else {
    nav.appendChild(btn);
  }
  nav.appendChild(wrap);

  btn.addEventListener('click', function () {
    var open = nav.classList.toggle('open');
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  });

  // Collapse the menu after a link is tapped on mobile.
  wrap.addEventListener('click', function (e) {
    if (e.target.tagName === 'A') {
      nav.classList.remove('open');
      btn.setAttribute('aria-expanded', 'false');
    }
  });
})();
