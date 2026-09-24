"use strict";
/**
 * @type {HTMLFormElement}
 */
const form = document.getElementById("sj-form");
/**
 * @type {HTMLInputElement}
 */
const address = document.getElementById("sj-address");
/**
 * @type {HTMLInputElement}
 */
const searchEngine = document.getElementById("sj-search-engine");
/**
 * @type {HTMLParagraphElement}
 */
const error = document.getElementById("sj-error");
/**
 * @type {HTMLPreElement}
 */
const errorCode = document.getElementById("sj-error-code");

const { ScramjetController } = $scramjetLoadController();

const scramjet = new ScramjetController({
	files: {
		wasm: "/scram/scramjet.wasm.wasm",
		all: "/scram/scramjet.all.js",
		sync: "/scram/scramjet.sync.js",
	},
});

scramjet.init();

const connection = new BareMux.BareMuxConnection("/baremux/worker.js");

form.addEventListener("submit", async (event) => {
	event.preventDefault();

	try {
		await registerSW();
	} catch (err) {
		error.textContent = "Failed to register service worker.";
		errorCode.textContent = err.toString();
		throw err;
	}

	const url = search(address.value, searchEngine.value);

	let wispUrl =
		(location.protocol === "https:" ? "wss" : "ws") +
		"://" +
		location.host +
		"/wisp/";
	if ((await connection.getTransport()) !== "/libcurl/index.mjs") {
		await connection.setTransport("/libcurl/index.mjs", [
			{ websocket: wispUrl },
		]);
	}
	const frame = scramjet.createFrame();
	frame.frame.id = "sj-frame";

	document.body.appendChild(frame.frame);
	frame.go(url);
});

/* ---- LobsterBrowse embedding patch ----
   Upstream file above is from MercuryWorkshop/Scramjet-App (AGPL).
   Loading the client with a ?url= parameter embeds it headlessly: the
   demo UI stays hidden (the inline head script in index.html hides the
   body immediately, before first paint) and the target loads inside a
   full-viewport Scramjet frame, so the tab shows only the target site. */
(async () => {
	const params = new URLSearchParams(location.search);
	const target = params.get("url");
	if (!target) return;

	form.style.display = "none";

	try {
		await registerSW();
	} catch (err) {
		error.textContent = "Failed to register service worker.";
		errorCode.textContent = err.toString();
		return;
	}

	const wispUrl =
		(location.protocol === "https:" ? "wss" : "ws") +
		"://" +
		location.host +
		"/wisp/";
	if ((await connection.getTransport()) !== "/libcurl/index.mjs") {
		await connection.setTransport("/libcurl/index.mjs", [
			{ websocket: wispUrl },
		]);
	}

	const frame = scramjet.createFrame();
	frame.frame.id = "sj-frame";
	frame.frame.className = "sj-embed";
	frame.frame.style.cssText =
		"position:fixed;inset:0;width:100%;height:100%;border:0;z-index:1;background:transparent;";
	document.body.appendChild(frame.frame);
	frame.go(target);
})();
