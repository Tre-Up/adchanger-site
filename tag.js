// biome-ignore-all lint/complexity/useOptionalChain: plain ES2017, so the tag also runs in older browsers
/*! AdChanger site tag: https://adchanger.net/measure
 * Tells AdChanger what happened after someone clicked a MacAd bar (the link carries ?mac=<click id>).
 * Sends only: the click id, the event's kind and time, and for a sale its order id, value and currency.
 * Stores nothing on the device unless the site grants consent; then one first-party cookie, _adchanger_mac,
 * holding the click id for 7 days. No localStorage, no fingerprinting, no third-party cookies. Never throws. */
((root) => {
  const ENDPOINT = "https://adidmymsbpzrumtytsmg.supabase.co/functions/v1/measure/event";
  const COOKIE = "_adchanger_mac";
  const WEEK = 604800; // seconds: the 7-day attribution window
  const CLICK = /^[a-z0-9]{12,32}$/;
  const KEY = /^pk_[0-9a-f]{24}$/;
  const CURRENCIES = ["GBP", "USD", "EUR"];
  const BATCH = 10;
  const ENGAGED_MS = 30000;

  /** "?mac=abc…" → the click id, or null when it is missing or not a click id. */
  const clickFrom = (search) => {
    try {
      const id = new URLSearchParams(search || "").get("mac");
      return id && CLICK.test(id) ? id : null;
    } catch (_) {
      return null;
    }
  };

  /** document.cookie → the stored click id, or null. */
  const cookieClick = (cookies) => {
    for (const part of String(cookies || "").split(";")) {
      const pair = part.trim().split("=");
      if (pair[0] === COOKIE) return CLICK.test(pair[1] || "") ? pair[1] : null;
    }
    return null;
  };

  /** The cookie to write: the click id for 7 days, or (id null) the cookie that deletes it. */
  const cookieString = (id, secure) =>
    `${COOKIE}=${id || ""}; Max-Age=${id ? WEEK : 0}; Path=/; SameSite=Lax${secure ? "; Secure" : ""}`;

  /** 49.99 → 4999. Anything that is not a sum of money (negative, NaN, huge) → null. */
  const toMinor = (value) => {
    const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return null;
    const minor = Math.round(n * 100);
    return Number.isSafeInteger(minor) ? minor : null;
  };

  /** "gbp" → "GBP"; anything but GBP, USD or EUR → null. */
  const currencyOf = (code) => {
    const c = typeof code === "string" ? code.trim().toUpperCase() : "";
    return CURRENCIES.indexOf(c) >= 0 ? c : null;
  };

  /** adchanger('purchase', {order_id, value, currency}) → the event; value only with a known currency. */
  const purchaseEvent = (details, at) => {
    const d = details && typeof details === "object" ? details : {};
    const event = { kind: "purchase", at };
    const order = typeof d.order_id === "number" ? String(d.order_id) : d.order_id;
    if (typeof order === "string" && order.trim() && order.trim().length <= 128) {
      event.order_id = order.trim();
    }
    const minor = toMinor(d.value);
    const currency = currencyOf(d.currency);
    if (minor !== null && currency) {
      event.value_minor = minor;
      event.currency = currency;
    }
    return event;
  };

  /** Scrolled from the top (0) to the bottom (1) of the page. */
  const scrollFraction = (top, viewport, height) => {
    const range = height - viewport;
    if (!(range > 0)) return 1;
    return Math.min(1, Math.max(0, Math.round((top / range) * 100) / 100));
  };

  /** The request bodies for these events: at most 10 events each. */
  const bodies = (key, mac, events) => {
    const out = [];
    for (let i = 0; i < events.length; i += BATCH) {
      out.push(JSON.stringify({ key, mac, events: events.slice(i, i + BATCH) }));
    }
    return out;
  };

  /**
   * The tag's state for one page view. `env` gives it the world: key, search, cookies, secure, consent,
   * now() (ms), send(body), setCookie(string), later(fn, ms) → cancel.
   */
  const createTracker = (env) => {
    const fromUrl = clickFrom(env.search);
    const mac = fromUrl || cookieClick(env.cookies);
    let consent = env.consent === true;
    let queue = [];
    let timer = null;
    const done = {};
    const at = () => new Date(env.now()).toISOString();

    const flush = () => {
      if (timer) timer();
      timer = null;
      if (!mac || !queue.length) return;
      const events = queue;
      queue = [];
      for (const body of bodies(env.key, mac, events)) env.send(body);
    };
    // Nothing is sent, now or later, without a click id.
    const push = (event) => {
      if (!mac) return;
      queue.push(event);
      if (queue.length >= BATCH) flush();
      else if (!timer) timer = env.later(flush, 1000);
    };
    const once = (kind, extra) => {
      if (done[kind]) return;
      done[kind] = true;
      const event = { kind, at: at() };
      for (const name in extra) event[name] = extra[name];
      push(event);
    };
    // Only a click that arrived in this page's address is stored, so the 7 days run from the click.
    const remember = () => {
      if (consent && fromUrl) env.setCookie(cookieString(fromUrl, env.secure));
    };

    const command = (name, arg) => {
      if (name === "consent") {
        consent = arg === true;
        if (consent) remember();
        else env.setCookie(cookieString(null, env.secure));
      } else if (name === "add_to_cart") push({ kind: "added_to_cart", at: at() });
      else if (name === "purchase") push(purchaseEvent(arg, at()));
    };

    remember();
    if (fromUrl) once("landed");
    else if (mac) once("looked_around"); // a second page, known only through the stored cookie
    return {
      mac,
      command,
      flush,
      engaged: (seconds) => once("engaged_30s", { seconds: Math.round(seconds) }),
      scrolled: (fraction) => {
        if (fraction >= 0.5) once("looked_around", { scroll: fraction });
      },
    };
  };

  const api = {
    ENDPOINT,
    COOKIE,
    clickFrom,
    cookieClick,
    cookieString,
    toMinor,
    currencyOf,
    purchaseEvent,
    scrollFraction,
    bodies,
    createTracker,
  };

  // Outside a browser (the site's tests), hand over the helpers instead of running.
  if (!root || !root.document) {
    if (typeof module === "object" && module) module.exports = api;
    return;
  }

  try {
    const doc = root.document;
    const existing = root.adchanger;
    if (existing && existing.loaded) return;
    const script =
      doc.currentScript || doc.querySelector('script[src*="adchanger.net/tag.js"]') || null;
    const key = script && script.getAttribute("data-key");
    if (!key || !KEY.test(key)) return;

    const send = (body) => {
      try {
        const nav = root.navigator;
        if (nav && nav.sendBeacon && nav.sendBeacon(ENDPOINT, body)) return;
        root
          .fetch(ENDPOINT, {
            method: "POST",
            body,
            keepalive: true,
            mode: "no-cors",
            credentials: "omit",
            headers: { "content-type": "text/plain" },
          })
          .catch(() => {});
      } catch (_) {}
    };
    const tracker = createTracker({
      key,
      search: root.location.search,
      cookies: doc.cookie,
      secure: root.location.protocol === "https:",
      consent: script.getAttribute("data-consent") === "granted",
      now: () => Date.now(),
      send,
      setCookie: (value) => {
        doc.cookie = value;
      },
      later: (fn, ms) => {
        const id = root.setTimeout(fn, ms);
        return () => root.clearTimeout(id);
      },
    });

    const adchanger = (name, arg) => {
      try {
        tracker.command(name, arg);
      } catch (_) {}
    };
    adchanger.loaded = true;
    // Calls made before the tag loaded (the snippet's stub queued them in adchanger.q), in order.
    const queued = (existing && existing.q) || [];
    for (let i = 0; i < queued.length; i++)
      adchanger(queued[i] && queued[i][0], queued[i] && queued[i][1]);
    root.adchanger = adchanger;
    if (!tracker.mac) return;

    // 30 seconds of the page being visible (paused while hidden), then engaged_30s once.
    let shown = 0;
    let since = null;
    let wait = null;
    const pause = () => {
      if (since !== null) shown += Date.now() - since;
      since = null;
      if (wait !== null) root.clearTimeout(wait);
      wait = null;
    };
    const resume = () => {
      if (since !== null || shown >= ENGAGED_MS) return;
      since = Date.now();
      wait = root.setTimeout(() => {
        pause();
        tracker.engaged(shown / 1000);
      }, ENGAGED_MS - shown);
    };
    const visible = () => doc.visibilityState !== "hidden";
    doc.addEventListener("visibilitychange", () => {
      if (visible()) resume();
      else {
        pause();
        tracker.flush();
      }
    });
    root.addEventListener("pagehide", tracker.flush);
    if (visible()) resume();

    let ticking = false;
    root.addEventListener(
      "scroll",
      () => {
        if (ticking) return;
        ticking = true;
        root.setTimeout(() => {
          ticking = false;
          const page = doc.documentElement;
          tracker.scrolled(scrollFraction(root.scrollY, root.innerHeight, page.scrollHeight));
        }, 250);
      },
      { passive: true },
    );
  } catch (_) {}
})(typeof window === "undefined" ? undefined : window);
