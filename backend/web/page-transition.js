(function () {
  const ENTER_MIN_DELAY_MS = 120;
  const ENTER_MAX_IMAGE_WAIT_MS = 700;
  const LEAVE_DELAY_MS = 140;

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function loadImage(img) {
    if (img.complete) return Promise.resolve();

    return new Promise((resolve) => {
      const done = () => resolve();
      img.addEventListener("load", done, { once: true });
      img.addEventListener("error", done, { once: true });
    });
  }

  function isEligibleLink(anchor) {
    const href = anchor.getAttribute("href") || "";
    if (!href || href.startsWith("#")) return false;
    if (anchor.target && anchor.target.toLowerCase() === "_blank") return false;
    if (anchor.hasAttribute("download")) return false;

    const url = new URL(anchor.href, window.location.href);
    if (url.origin !== window.location.origin) return false;
    if (url.pathname.startsWith("/api/")) return false;

    const samePage =
      url.pathname === window.location.pathname &&
      url.search === window.location.search &&
      url.hash === window.location.hash;

    return !samePage;
  }

  async function revealPage() {
    const body = document.body;
    const waitForImages = body.dataset.waitImages === "true";
    const started = Date.now();

    if (waitForImages) {
      const images = Array.from(document.querySelectorAll("main img"));
      await Promise.race([
        Promise.all(images.map(loadImage)),
        wait(ENTER_MAX_IMAGE_WAIT_MS),
      ]);
    }

    const elapsed = Date.now() - started;
    if (elapsed < ENTER_MIN_DELAY_MS) {
      await wait(ENTER_MIN_DELAY_MS - elapsed);
    }

    body.classList.remove("page-preload", "page-leave");
    body.classList.add("page-ready");
  }

  function attachLeaveTransition() {
    document.addEventListener("click", (event) => {
      const anchor = event.target.closest("a[href]");
      if (!anchor || !isEligibleLink(anchor)) return;

      event.preventDefault();
      document.body.classList.remove("page-ready");
      document.body.classList.add("page-leave");

      window.setTimeout(() => {
        window.location.assign(anchor.href);
      }, LEAVE_DELAY_MS);
    });
  }

  function init() {
    revealPage();
    attachLeaveTransition();

    window.addEventListener("pageshow", () => {
      document.body.classList.remove("page-preload", "page-leave");
      document.body.classList.add("page-ready");
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
