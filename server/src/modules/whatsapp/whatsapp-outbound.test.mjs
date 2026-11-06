import assert from "node:assert/strict";
import test from "node:test";

import { Miniflare } from "miniflare";

import { createDatabase, enableFeatures, loadModule } from "../../data/test-support.mjs";

const { createApp } = await loadModule("../app.ts");
const { createIdentityRepository } = await loadModule("./identity.ts");
const { purgeStaleAttachments } = await loadModule("../retention/attachments.ts");
const adminSecret = "synthetic-outbound-admin-secret-not-for-deployment";
const tokenSecret = "synthetic-outbound-token-secret-not-for-deployment";
const whatsapp = {
  WHATSAPP_TOKEN: "synthetic-token", WHATSAPP_PHONE_NUMBER_ID: "1000000000000001", WHATSAPP_WABA_ID: "1000000000000002",
  WHATSAPP_APP_SECRET: "synthetic-app-secret", WHATSAPP_VERIFY_TOKEN: "synthetic-verify",
};

const jpeg = (extra = 8) => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...Array.from({ length: extra }, (_, index) => index + 1)]);
const png = () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const webp = () => new Uint8Array([...new TextEncoder().encode("RIFF"), 1, 0, 0, 0, ...new TextEncoder().encode("WEBPVP8 ")]);
const mp4 = () => new Uint8Array([0, 0, 0, 24, ...new TextEncoder().encode("ftypisom")]);
const pdf = () => new TextEncoder().encode("%PDF-1.4 synthetic");

const templates = [
  { name: "hello_world", language: "en_US", status: "APPROVED", category: "UTILITY", components: [{ type: "BODY", text: "Hello" }] },
  { name: "with_image", language: "en_US", status: "APPROVED", category: "MARKETING", components: [
    { type: "HEADER", format: "IMAGE" }, { type: "BODY", text: "Look at {{1}}", example: { body_text: [["this"]] } }] },
  { name: "with_document", language: "en_US", status: "APPROVED", category: "UTILITY", components: [
    { type: "HEADER", format: "DOCUMENT" }, { type: "BODY", text: "Your file" }] },
  { name: "header_variable", language: "en_US", status: "APPROVED", category: "UTILITY", components: [
    { type: "HEADER", format: "TEXT", text: "Hi {{1}}" }, { type: "BODY", text: "x" }] },
];

/** A fake Graph API: lists templates, accepts media uploads and message sends, and records every call. */
function stubGraph(t, { messageReply } = {}) {
  const uploads = [], sends = [];
  let mediaCounter = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith("/message_templates")) {
      const wanted = new URL(String(url)).searchParams.get("name");
      return new Response(JSON.stringify({ data: templates.filter((x) => !wanted || x.name === wanted) }), { status: 200 });
    }
    if (path.endsWith("/media")) {
      const form = init.body;
      assert.ok(form instanceof FormData);
      const file = form.get("file");
      uploads.push({ url: String(url), auth: init.headers.Authorization, product: form.get("messaging_product"), type: form.get("type"),
        fileName: file.name, fileType: file.type, size: file.size });
      return new Response(JSON.stringify({ id: String(7000000 + ++mediaCounter) }), { status: 200 });
    }
    sends.push({ url: String(url), auth: init.headers.Authorization, body: JSON.parse(init.body) });
    return messageReply ? messageReply(sends.length, sends.at(-1)) : new Response(JSON.stringify({ messages: [{ id: `wamid.OUT${sends.length}` }] }), { status: 200 });
  };
  t.after(() => { globalThis.fetch = original; });
  return { uploads, sends };
}

async function fixture(t, extraEnv = whatsapp) {
  const DB = await createDatabase(t);
  await enableFeatures(DB);
  const runtime = new Miniflare({
    workers: [{ config: {
      name: "outbound-tests", compatibilityDate: "2026-09-24",
      manifest: { mainModule: "index.js", modules: { "index.js": { type: "esm", contents: "export default { fetch() { return new Response(null, { status: 404 }); } }" } } },
      env: { RECORDINGS: { type: "r2", name: "outbound-test-bucket" } },
    } }],
  });
  t.after(() => runtime.dispose());
  const RECORDINGS = await runtime.getR2Bucket("RECORDINGS");
  const identity = createIdentityRepository(DB, tokenSecret);
  const alice = await identity.createEmployee({ name: "Alice" });
  const bob = await identity.createEmployee({ name: "Bob" });
  const enroll = async (employee) => identity.redeemInvitation(
    (await identity.createInvitation(employee.id, "2099-01-01T00:00:00Z")).invitationCode, { model: "Synthetic" });
  const aliceDevice = await enroll(alice), bobDevice = await enroll(bob);
  const env = { DB, RECORDINGS, TOKEN_HASH_SECRET: tokenSecret, LOCAL_ADMIN_SECRET: adminSecret, ENVIRONMENT: "development", ...extraEnv };
  const app = createApp();
  const request = (path, init = {}) => app.request(new URL(path, "http://127.0.0.1"), init, env);
  const admin = (method, path, body) => request(path, {
    method, headers: { Authorization: `Bearer ${adminSecret}`, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const device = (who, method, path, body) => request(path, {
    method, headers: { Authorization: `Bearer ${who.deviceToken}`, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const upload = (as, bytes, contentType, fileName = "photo.jpg") => {
    const headers = { "Content-Type": contentType, ...(as === "admin" ? { Authorization: `Bearer ${adminSecret}` } : as ? { Authorization: `Bearer ${as.deviceToken}` } : {}) };
    const path = `/v1/${as === "admin" || !as ? "admin" : "device"}/whatsapp/attachments?fileName=${encodeURIComponent(fileName)}`;
    return request(path, { method: "POST", headers, body: bytes });
  };
  const customer = (await (await admin("POST", "/v1/admin/customers", { name: "Buyer", phone: "9876543210", employeeIds: [alice.id, bob.id] })).json()).customer;
  const openWindow = (at = new Date()) => DB.prepare(
    "INSERT INTO whatsapp_messages (id, customer_id, direction, message_type, body, status, sent_at, source, created_at) VALUES (?, ?, 'in', 'text', 'hi', 'delivered', ?, 'import', ?)",
  ).bind(`wam_in_${crypto.randomUUID()}`, customer.id, at.toISOString(), at.toISOString()).run();
  const send = (body, who) => who
    ? device(who, "POST", `/v1/device/customers/${customer.id}/messages`, body)
    : admin("POST", `/v1/admin/customers/${customer.id}/messages`, body);
  const messages = async () => (await (await admin("GET", `/v1/admin/customers/${customer.id}/messages`)).json()).items;
  return { DB, RECORDINGS, alice, bob, aliceDevice, bobDevice, env, request, admin, device, upload, customer, openWindow, send, messages };
}

const uuid = () => crypto.randomUUID();

test("uploads accept only the allow-listed types, check the bytes, and store the file privately", async (t) => {
  const f = await fixture(t);
  const ok = await f.upload("admin", jpeg(), "image/jpeg; charset=binary", "../../we ird\u0000 \"name\".jpg");
  assert.equal(ok.status, 201);
  const body = await ok.json();
  assert.match(body.attachmentId, /^wat_/);
  assert.deepEqual([body.kind, body.mimeType, body.size], ["image", "image/jpeg", jpeg().length]);
  assert.equal(body.fileName, "we ird name.jpg");
  const stored = await f.RECORDINGS.get(`whatsapp-outbound/${body.attachmentId}`);
  assert.deepEqual(new Uint8Array(await stored.arrayBuffer()), jpeg());

  for (const [bytes, type, status, code] of [
    [new Uint8Array([1, 2, 3]), "application/zip", 400, "unsupported_media_type"],
    [new Uint8Array([1, 2, 3]), "text/html", 400, "unsupported_media_type"],
    [new TextEncoder().encode("not a jpeg"), "image/jpeg", 400, "unsupported_media_type"],
    [new Uint8Array(0), "image/png", 400, "empty_file"],
    [new Uint8Array(5 * 1024 * 1024 + 1).fill(0).map((_, index) => (index < 4 ? jpeg()[index] : 0)), "image/jpeg", 413, "file_too_large"],
    [new Uint8Array(16 * 1024 * 1024 + 1).map((_, index) => (index < 4 ? "%PDF".charCodeAt(index) : 0)), "application/pdf", 413, "file_too_large"],
  ]) {
    const refused = await f.upload("admin", bytes, type);
    assert.equal(refused.status, status, `${type} ${bytes.length}`);
    assert.equal((await refused.json()).error.code, code);
  }
  for (const [bytes, type, kind] of [
    [png(), "image/png", "image"], [pdf(), "application/pdf", "document"],
    [new TextEncoder().encode("a,b\n1,2"), "text/csv", "document"], [mp4(), "video/mp4", "video"],
  ]) {
    const accepted = await f.upload("admin", bytes, type, "file");
    assert.equal(accepted.status, 201, type);
    assert.equal((await accepted.json()).kind, kind);
  }
  const keys = (await f.RECORDINGS.list({ prefix: "whatsapp-outbound/" })).objects;
  assert.equal(keys.length, 5);
});

test("uploads need the right credentials", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request("/v1/device/whatsapp/attachments", { method: "POST", headers: { "Content-Type": "image/jpeg" }, body: jpeg() })).status, 401);
  assert.equal((await f.request("/v1/device/whatsapp/attachments", { method: "POST", headers: { Authorization: "Bearer nope", "Content-Type": "image/jpeg" }, body: jpeg() })).status, 401);
  assert.equal((await f.request("/v1/admin/whatsapp/attachments", { method: "POST", headers: { "Content-Type": "image/jpeg" }, body: jpeg() })).status, 401);
  assert.equal((await f.upload(f.aliceDevice, jpeg(), "image/jpeg")).status, 201);
  assert.equal((await f.RECORDINGS.list({ prefix: "whatsapp-outbound/" })).objects.length, 1);
});

test("a device can use only its own attachments, and administrators only theirs", async (t) => {
  const f = await fixture(t);
  const { sends } = stubGraph(t);
  await f.openWindow();
  const mine = (await (await f.upload(f.aliceDevice, jpeg(), "image/jpeg")).json()).attachmentId;
  const adminFile = (await (await f.upload("admin", jpeg(), "image/jpeg")).json()).attachmentId;
  const media = (attachmentId, as) => f.send({ clientMessageId: uuid(), type: "media", attachmentId }, as);

  const stolen = await media(mine, f.bobDevice);
  assert.equal(stolen.status, 404);
  assert.equal((await stolen.json()).error.code, "attachment_not_found");
  assert.equal((await media(adminFile, f.aliceDevice)).status, 404);
  assert.equal((await media(mine)).status, 404);
  assert.equal((await media("wat_does-not-exist", f.aliceDevice)).status, 404);
  assert.equal(sends.length, 0);
  assert.equal((await f.messages()).filter((m) => m.direction === "out").length, 0);

  assert.equal((await media(mine, f.aliceDevice)).status, 201);
  assert.equal((await media(adminFile)).status, 201);
  assert.equal(sends.length, 2);
  // Admin-only previews: a device file is not readable through the admin attachment URL.
  assert.equal((await f.admin("GET", `/v1/admin/whatsapp/attachments/${mine}`)).status, 404);
  assert.equal((await f.admin("GET", `/v1/admin/whatsapp/attachments/${adminFile}`)).status, 200);
});

test("a media message uploads the file to Meta, sends it with its caption, and shows in the chat", async (t) => {
  const f = await fixture(t);
  const { uploads, sends } = stubGraph(t);
  await f.openWindow();
  const id = (await (await f.upload(f.aliceDevice, jpeg(), "image/jpeg", "shop.jpg")).json()).attachmentId;
  const sent = await f.send({ clientMessageId: uuid(), type: "media", attachmentId: id, caption: "Our shop" }, f.aliceDevice);
  assert.equal(sent.status, 201);
  const message = (await sent.json()).message;
  assert.deepEqual([message.messageType, message.body, message.status, message.sentBy.name], ["image", "Our shop", "sent", "Alice"]);
  assert.deepEqual([message.media.kind, message.media.mimeType, message.media.fileName, message.media.size],
    ["image", "image/jpeg", "shop.jpg", jpeg().length]);
  assert.equal(message.media.url, `/v1/device/whatsapp/messages/${message.id}/media`);

  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].url, "https://graph.facebook.com/v23.0/1000000000000001/media");
  assert.deepEqual([uploads[0].auth, uploads[0].product, uploads[0].type, uploads[0].fileName, uploads[0].size],
    ["Bearer synthetic-token", "whatsapp", "image/jpeg", "shop.jpg", jpeg().length]);
  assert.equal(sends[0].url, "https://graph.facebook.com/v23.0/1000000000000001/messages");
  assert.deepEqual(sends[0].body, {
    messaging_product: "whatsapp", recipient_type: "individual", to: "919876543210",
    type: "image", image: { id: "7000001", caption: "Our shop" },
  });

  const bytes = await f.device(f.aliceDevice, "GET", message.media.url);
  assert.equal(bytes.status, 200);
  assert.equal(bytes.headers.get("Content-Type"), "image/jpeg");
  assert.deepEqual(new Uint8Array(await bytes.arrayBuffer()), jpeg());
  // The admin sees the same message with the admin media URL.
  const seen = (await f.messages()).find((m) => m.id === message.id);
  assert.equal(seen.media.url, `/v1/admin/whatsapp/messages/${message.id}/media`);
  assert.equal((await f.admin("GET", seen.media.url)).status, 200);

  // Sending the same file again reuses Meta's media id instead of uploading again.
  await f.send({ clientMessageId: uuid(), type: "media", attachmentId: id }, f.aliceDevice);
  assert.equal(uploads.length, 1);
  assert.deepEqual(sends[1].body.image, { id: "7000001" });
});

test("a document is sent with its file name; video goes out as video", async (t) => {
  const f = await fixture(t);
  const { sends } = stubGraph(t);
  await f.openWindow();
  const doc = (await (await f.upload("admin", pdf(), "application/pdf", "price list.pdf")).json()).attachmentId;
  const video = (await (await f.upload("admin", mp4(), "video/mp4", "demo.mp4")).json()).attachmentId;
  assert.equal((await f.send({ clientMessageId: uuid(), type: "media", attachmentId: doc, caption: "Prices" })).status, 201);
  assert.equal((await f.send({ clientMessageId: uuid(), type: "media", attachmentId: video })).status, 201);
  assert.deepEqual(sends[0].body.document, { id: "7000001", caption: "Prices", filename: "price list.pdf" });
  assert.equal(sends[0].body.type, "document");
  assert.equal(sends[1].body.type, "video");
  assert.deepEqual(sends[1].body.video, { id: "7000002" });
  const [newest, older] = await f.messages();
  assert.deepEqual([newest.messageType, older.messageType, older.media.fileName], ["video", "document", "price list.pdf"]);
});

test("a cached Meta media id that Meta rejects is replaced by one fresh upload", async (t) => {
  const f = await fixture(t);
  const { uploads, sends } = stubGraph(t, {
    messageReply: (count) => count === 2
      ? new Response(JSON.stringify({ error: { code: 131053, message: "secret detail" } }), { status: 400 })
      : new Response(JSON.stringify({ messages: [{ id: `wamid.R${count}` }] }), { status: 200 }),
  });
  await f.openWindow();
  const id = (await (await f.upload("admin", jpeg(), "image/jpeg")).json()).attachmentId;
  await f.send({ clientMessageId: uuid(), type: "media", attachmentId: id });
  const second = await f.send({ clientMessageId: uuid(), type: "media", attachmentId: id });
  assert.equal(second.status, 201);
  assert.equal(uploads.length, 2);
  assert.deepEqual(sends.map((send) => send.body.image.id), ["7000001", "7000001", "7000002"]);
  // A rejection on a freshly uploaded id is final.
  const failing = stubGraph(t, { messageReply: () => new Response(JSON.stringify({ error: { code: 131053, message: "secret detail" } }), { status: 400 }) });
  const other = (await (await f.upload("admin", png(), "image/png")).json()).attachmentId;
  const failed = await f.send({ clientMessageId: uuid(), type: "media", attachmentId: other });
  assert.equal(failed.status, 502);
  assert.doesNotMatch(await failed.text(), /secret detail|synthetic-token/);
  assert.equal(failing.uploads.length, 1);
});

test("free text and files are refused with window_closed after 24 hours, and templates still go", async (t) => {
  const f = await fixture(t);
  const { uploads, sends } = stubGraph(t);
  const id = (await (await f.upload("admin", jpeg(), "image/jpeg")).json()).attachmentId;
  const closed = async () => {
    for (const body of [{ clientMessageId: uuid(), text: "hi" }, { clientMessageId: uuid(), type: "media", attachmentId: id }]) {
      const response = await f.send(body);
      assert.equal(response.status, 409);
      assert.equal((await response.json()).error.code, "window_closed");
    }
  };
  await closed();
  await f.openWindow(new Date(Date.now() - 25 * 3600e3));
  await closed();
  assert.equal(sends.length + uploads.length, 0);
  assert.equal((await f.send({ clientMessageId: uuid(), template: { name: "hello_world" } })).status, 201);

  await f.openWindow(new Date(Date.now() - 23 * 3600e3));
  assert.equal((await f.send({ clientMessageId: uuid(), type: "media", attachmentId: id })).status, 201);
});

test("Meta's own re-engagement error on free text is reported as window_closed", async (t) => {
  const f = await fixture(t);
  stubGraph(t, { messageReply: () => new Response(JSON.stringify({ error: { code: 131047, message: "secret detail" } }), { status: 400 }) });
  await f.openWindow();
  const response = await f.send({ clientMessageId: uuid(), text: "hello" });
  assert.equal(response.status, 409);
  const text = await response.text();
  assert.match(text, /window_closed/);
  assert.doesNotMatch(text, /secret detail/);
  assert.equal((await f.messages()).find((m) => m.direction === "out").status, "failed");
});

test("a WebP image cannot be sent as an image", async (t) => {
  const f = await fixture(t);
  const { uploads } = stubGraph(t);
  await f.openWindow();
  const upload = await f.upload("admin", webp(), "image/webp", "sticker.webp");
  assert.equal(upload.status, 201);
  const refused = await f.send({ clientMessageId: uuid(), type: "media", attachmentId: (await upload.json()).attachmentId });
  assert.equal(refused.status, 400);
  assert.equal((await refused.json()).error.code, "unsupported_media_type");
  assert.equal(uploads.length, 0);
});

test("the send body is validated", async (t) => {
  const f = await fixture(t);
  stubGraph(t);
  await f.openWindow();
  for (const body of [
    { clientMessageId: uuid(), type: "media" },
    { clientMessageId: uuid(), type: "media", attachmentId: "../etc" },
    { clientMessageId: uuid(), type: "media", attachmentId: "wat_x", text: "also text" },
    { clientMessageId: uuid(), text: "x", template: { name: "hello_world" } },
    { clientMessageId: uuid() },
    { clientMessageId: uuid(), template: { name: "hello_world", headerAttachmentId: "nope" } },
  ]) assert.equal((await f.send(body)).status, 400, JSON.stringify(body));
});

test("a template with an image header needs a file; the Config default is used unless the sender picks another", async (t) => {
  const f = await fixture(t);
  const { uploads, sends } = stubGraph(t);
  const template = (extra = {}) => ({ clientMessageId: uuid(), template: { name: "with_image", language: "en_US", params: ["this"], ...extra } });

  // Listed as sendable, but with no file nothing is sent or stored.
  const list = (await (await f.admin("GET", "/v1/admin/whatsapp/templates")).json()).items;
  const entry = list.find((x) => x.name === "with_image");
  assert.deepEqual([entry.sendable, entry.headerFormat, entry.headerImageConfigured, entry.headerImageUrl], [true, "IMAGE", false, undefined]);
  assert.equal(list.find((x) => x.name === "with_document").headerFormat, "DOCUMENT");
  assert.equal(list.find((x) => x.name === "header_variable").sendable, false);
  const missing = await f.send(template());
  assert.equal(missing.status, 400);
  assert.equal((await missing.json()).error.code, "template_header_image_required");
  assert.equal(sends.length + uploads.length, 0);
  assert.equal((await f.messages()).length, 0);

  // The admin picks the default image for the template.
  const image = (await (await f.upload("admin", jpeg(), "image/jpeg", "banner.jpg")).json()).attachmentId;
  const doc = (await (await f.upload("admin", pdf(), "application/pdf", "a.pdf")).json()).attachmentId;
  const put = (name, attachmentId) => f.admin("PUT", `/v1/admin/whatsapp/template-images/${name}`, { attachmentId });
  assert.equal((await put("with_image", doc)).status, 400, "a document is not an image header");
  assert.equal((await put("hello_world", image)).status, 400, "the template has no media header");
  assert.equal((await put("no_such_template", image)).status, 400);
  assert.equal((await put("with_image", "wat_missing")).status, 404);
  const saved = await put("with_image", image);
  assert.equal(saved.status, 200);
  assert.deepEqual((await saved.json()).item, { templateName: "with_image", attachmentId: image, kind: "image", mimeType: "image/jpeg", fileName: "banner.jpg", size: jpeg().length });
  assert.deepEqual((await (await f.admin("GET", "/v1/admin/whatsapp/template-images")).json()).items.map((x) => x.templateName), ["with_image"]);

  for (const [who, base] of [["admin", "/v1/admin"], [f.aliceDevice, "/v1/device"]]) {
    const items = (await (await (who === "admin" ? f.admin("GET", `${base}/whatsapp/templates`) : f.device(who, "GET", `${base}/whatsapp/templates`))).json()).items;
    const configured = items.find((x) => x.name === "with_image");
    assert.deepEqual([configured.headerImageConfigured, configured.headerImageUrl], [true, `${base}/whatsapp/templates/with_image/header-image`]);
    const preview = who === "admin" ? await f.admin("GET", configured.headerImageUrl) : await f.device(who, "GET", configured.headerImageUrl);
    assert.equal(preview.status, 200);
    assert.deepEqual(new Uint8Array(await preview.arrayBuffer()), jpeg());
  }

  // Default image: uploaded to Meta once and sent as the header component; the chat shows the image and the body text.
  const sent = await f.send(template());
  assert.equal(sent.status, 201);
  const message = (await sent.json()).message;
  assert.deepEqual([message.messageType, message.templateName, message.body, message.media.kind, message.media.fileName], ["template", "with_image", "Look at this", "image", "banner.jpg"]);
  assert.deepEqual(sends[0].body.template, {
    name: "with_image", language: { code: "en_US" },
    components: [
      { type: "header", parameters: [{ type: "image", image: { id: "7000001" } }] },
      { type: "body", parameters: [{ type: "text", text: "this" }] },
    ],
  });
  assert.equal(uploads.length, 1);
  await f.send(template());
  assert.equal(uploads.length, 1, "the Meta media id is reused");

  // An employee overrides with their own file; admin files are not theirs to use.
  const own = (await (await f.upload(f.aliceDevice, png(), "image/png", "mine.png")).json()).attachmentId;
  const overridden = await f.send(template({ headerAttachmentId: own }), f.aliceDevice);
  assert.equal(overridden.status, 201);
  assert.equal(sends.at(-1).body.template.components[0].parameters[0].image.id, "7000002");
  assert.equal((await overridden.json()).message.media.fileName, "mine.png");
  assert.equal((await f.send(template({ headerAttachmentId: image }), f.aliceDevice)).status, 404);
  assert.equal((await f.send(template({ headerAttachmentId: (await (await f.upload(f.aliceDevice, pdf(), "application/pdf")).json()).attachmentId }), f.aliceDevice)).status, 400);
  // A template without a media header refuses an override.
  assert.equal((await f.send({ clientMessageId: uuid(), template: { name: "hello_world", headerAttachmentId: own } }, f.aliceDevice)).status, 400);

  // Clearing the default brings back the error.
  assert.equal((await f.admin("DELETE", "/v1/admin/whatsapp/template-images/with_image")).status, 200);
  assert.equal((await f.send(template())).status, 400);
  assert.deepEqual((await (await f.admin("GET", "/v1/admin/whatsapp/template-images")).json()).items, []);
  assert.equal((await f.admin("GET", "/v1/admin/whatsapp/templates/with_image/header-image")).status, 404);
});

test("template header images are admin-managed; devices cannot change them", async (t) => {
  const f = await fixture(t);
  stubGraph(t);
  const own = (await (await f.upload(f.aliceDevice, jpeg(), "image/jpeg")).json()).attachmentId;
  for (const method of ["GET", "PUT", "DELETE"]) {
    const response = await f.device(f.aliceDevice, method, "/v1/device/whatsapp/template-images/with_image", method === "PUT" ? { attachmentId: own } : undefined);
    assert.equal(response.status, 404, method);
  }
  // An admin cannot adopt a device's file as the default either.
  assert.equal((await f.admin("PUT", "/v1/admin/whatsapp/template-images/with_image", { attachmentId: own })).status, 404);
});

test("customer detail and chat lists carry the 24-hour window for admin and employee", async (t) => {
  const f = await fixture(t);
  const read = async (get) => {
    const detail = (await (await get(`/customers/${f.customer.id}`)).json()).customer.whatsappWindow;
    const chats = (await (await get("/whatsapp/chats")).json()).items;
    return { detail, chat: chats[0]?.whatsappWindow };
  };
  const adminGet = (path) => f.admin("GET", `/v1/admin${path}`);
  const deviceGet = (path) => f.device(f.aliceDevice, "GET", `/v1/device${path}`);
  const arrival = new Date(Date.now() - 3600e3);
  assert.deepEqual((await read(adminGet)).detail, { open: false, expiresAt: null });
  await f.openWindow(arrival);
  const expected = { open: true, expiresAt: new Date(arrival.getTime() + 24 * 3600e3).toISOString() };
  for (const get of [adminGet, deviceGet]) assert.deepEqual(await read(get), { detail: expected, chat: expected });
  await f.DB.prepare("UPDATE whatsapp_messages SET sent_at = ?").bind(new Date(Date.now() - 25 * 3600e3).toISOString()).run();
  for (const get of [adminGet, deviceGet]) assert.deepEqual(await read(get), { detail: { open: false, expiresAt: null }, chat: { open: false, expiresAt: null } });
});

test("employees read the template list and quick messages; unconfigured WhatsApp answers 503", async (t) => {
  const f = await fixture(t);
  stubGraph(t);
  await f.admin("POST", "/v1/admin/whatsapp/quick-messages", { title: "Greeting", text: "Hello!" });
  const quick = await f.device(f.bobDevice, "GET", "/v1/device/whatsapp/quick-messages");
  assert.deepEqual((await quick.json()).items.map((x) => x.title), ["Greeting"]);
  const list = await f.device(f.bobDevice, "GET", "/v1/device/whatsapp/templates");
  assert.equal(list.status, 200);
  assert.deepEqual((await list.json()).items.map((x) => x.name), ["hello_world", "with_document", "with_image", "header_variable"]);
  assert.equal((await f.request("/v1/device/whatsapp/templates")).status, 401);
  const off = await fixture(t, { ...whatsapp, WHATSAPP_WABA_ID: undefined });
  assert.equal((await off.device(off.aliceDevice, "GET", "/v1/device/whatsapp/templates")).status, 503);
});

test("cleanup removes old unsent uploads and keeps files a message or a template default uses", async (t) => {
  const f = await fixture(t);
  stubGraph(t);
  await f.openWindow();
  const upload = async (bytes = jpeg()) => (await (await f.upload("admin", bytes, "image/jpeg")).json()).attachmentId;
  const abandoned = await upload(jpeg(3)), sent = await upload(jpeg(4)), defaulted = await upload(jpeg(5)), fresh = await upload(jpeg(6));
  await f.send({ clientMessageId: uuid(), type: "media", attachmentId: sent });
  assert.equal((await f.admin("PUT", "/v1/admin/whatsapp/template-images/with_image", { attachmentId: defaulted })).status, 200);
  const old = new Date(Date.now() - 5 * 24 * 3600e3).toISOString();
  await f.DB.prepare("UPDATE whatsapp_attachments SET created_at = ? WHERE id IN (?, ?, ?)").bind(old, abandoned, sent, defaulted).run();

  assert.equal(await purgeStaleAttachments(f.env), 1);
  const remaining = (await f.DB.prepare("SELECT id FROM whatsapp_attachments ORDER BY id").all()).results.map((row) => row.id).sort();
  assert.deepEqual(remaining, [sent, defaulted, fresh].sort());
  assert.equal(await f.RECORDINGS.get(`whatsapp-outbound/${abandoned}`), null);
  assert.notEqual(await f.RECORDINGS.get(`whatsapp-outbound/${sent}`), null);
  assert.equal(await purgeStaleAttachments(f.env), 0);
});
