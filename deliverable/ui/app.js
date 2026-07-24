/**
 * AWS Cost Analyzer – thin chatbot UI
 *
 * THIN-CLIENT RULE: every value shown to the user comes from a JSON-RPC
 * "tools/call" POST to the MCP endpoint via fetch().
 * No pricing tables, no business logic, no local calculations live here.
 *
 * Wire contract (JSON-RPC 2.0):
 *   tools/list  → { "tools": [...] }
 *   tools/call  → { "content": [{ "type": "text", "text": "<json>" }] }
 */

const MCP_ENDPOINT = "http://127.0.0.1:50851";
let _rpcId = 1;

/* ------------------------------------------------------------------ */
/*  Core MCP transport                                                  */
/* ------------------------------------------------------------------ */

/**
 * Send a JSON-RPC 2.0 POST to the MCP endpoint via fetch().
 * Returns the "result" field of the response, or throws on JSON-RPC error.
 */
async function mcpRpc(method, params = {}) {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    method,
    id: _rpcId++,
    params,
  });

  const response = await fetch(MCP_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });

  const payload = await response.json();

  if (payload.error) {
    const err = payload.error;
    throw new Error(`RPC error ${err.code}: ${err.message}`);
  }
  return payload.result;
}

/**
 * Discover available tools from the server (tools/list).
 */
async function listTools() {
  const result = await mcpRpc("tools/list");
  return Array.isArray(result) ? result : (result.tools ?? []);
}

/**
 * Invoke a tool by name (tools/call) and unwrap the structured result.
 * Returns the parsed JSON object from the text content block.
 */
async function callTool(name, args) {
  const result = await mcpRpc("tools/call", { name, arguments: args });

  // MCP wraps responses: { content: [{ type:"text", text:"<json>" }] }
  if (result && Array.isArray(result.content)) {
    for (const block of result.content) {
      if (block.type === "text") {
        return JSON.parse(block.text);
      }
    }
  }
  return result;
}

/* ------------------------------------------------------------------ */
/*  Intent parser (no pricing math – only routing)                     */
/* ------------------------------------------------------------------ */

/**
 * Best-effort parse of a free-text query into { toolName, args } or null.
 * This is pure intent parsing; no numbers it computes reach the UI –
 * they are just routing hints forwarded to tools/call.
 */
function parseIntent(text) {
  const t = text.toLowerCase().trim();

  // recommend instance: "recommend 4 vcpu 16 gib" / "need 2 cpu 8 gb"
  const rec = t.match(/(?:recommend|need|suggest|find)\D*?(\d+)\s*(?:vcpu|cpu|core)s?\D*?(\d+)\s*(?:gib|gb|g)/i);
  if (rec) {
    return { toolName: "recommend_instance", args: { vcpus: parseInt(rec[1], 10), memory_gib: parseInt(rec[2], 10) } };
  }

  // EBS: "100 gb gp3" / "gp3 500gb" / "ebs io1 200"
  const ebs = t.match(/(?:ebs\s+)?(\d+(?:\.\d+)?)\s*gb\s+(gp3|gp2|io1|st1|sc1)|(?:ebs\s+)?(gp3|gp2|io1|st1|sc1)\s+(\d+(?:\.\d+)?)\s*gb|ebs\s+(gp3|gp2|io1|st1|sc1)\s+(\d+(?:\.\d+)?)/i);
  if (ebs) {
    const size = parseFloat(ebs[1] || ebs[4] || ebs[6]);
    const vtype = (ebs[2] || ebs[3] || ebs[5] || "").toLowerCase();
    if (vtype && size >= 0) {
      return { toolName: "estimate_ebs_monthly_cost", args: { volume_type: vtype, size_gb: size } };
    }
  }

  // S3: "s3 100 gb" / "100 gb glacier" / "200gb standard_ia"
  const s3Classes = ["standard_ia", "standard", "glacier"];
  for (const sc of s3Classes) {
    const re = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*gb[\\s,]*${sc}|${sc}[\\s,]*(\\d+(?:\\.\\d+)?)\\s*gb|s3[^]*?(\\d+(?:\\.\\d+)?)\\s*gb`, "i");
    const m = t.match(re);
    if (m) {
      const storage = parseFloat(m[1] || m[2] || m[3]);
      return { toolName: "estimate_s3_monthly_cost", args: { storage_gb: storage, storage_class: sc.toUpperCase() } };
    }
  }
  // generic "s3 100gb"
  const s3generic = t.match(/s3\s+(\d+(?:\.\d+)?)\s*gb/i);
  if (s3generic) {
    return { toolName: "estimate_s3_monthly_cost", args: { storage_gb: parseFloat(s3generic[1]) } };
  }

  // EC2 instance type with optional count
  const instanceTypes = ["t3.micro","t3.small","t3.medium","m5.large","m5.xlarge","c5.large","c5.xlarge","r5.large","r5.xlarge"];
  for (const inst of instanceTypes) {
    if (t.includes(inst)) {
      const countMatch = t.match(/[×x*]\s*(\d+)|(\d+)\s*[×x*]|count\s+(\d+)|(\d+)\s+instance/i);
      const count = countMatch ? parseInt(countMatch[1] || countMatch[2] || countMatch[3] || countMatch[4], 10) : 1;
      return { toolName: "estimate_ec2_monthly_cost", args: { instance_type: inst, count } };
    }
  }

  return null;
}

/* ------------------------------------------------------------------ */
/*  Result renderer                                                     */
/* ------------------------------------------------------------------ */

function renderResult(toolName, data) {
  const div = document.createElement("div");

  // Monthly cost highlight (present on all tools)
  if ("monthly_cost" in data || "total_monthly_cost" in data) {
    const cost = data.monthly_cost ?? data.total_monthly_cost;
    const currency = data.currency ?? "USD";
    const h = document.createElement("div");
    h.className = "cost-highlight";
    h.textContent = `$${cost.toFixed(2)} / month`;
    const lbl = document.createElement("div");
    lbl.className = "cost-label";
    lbl.textContent = currency + " · estimated";
    div.appendChild(h);
    div.appendChild(lbl);
  }

  // recommend_instance: show recommendation prominently
  if (toolName === "recommend_instance" && data.recommended_instance_type) {
    const rec = document.createElement("p");
    rec.style.cssText = "margin:8px 0 4px; font-weight:700;";
    rec.textContent = `Recommended: ${data.recommended_instance_type} (${data.vcpus} vCPU, ${data.memory_gib} GiB)`;
    div.appendChild(rec);
  }

  // estimate_stack_monthly_cost: line items table
  if (toolName === "estimate_stack_monthly_cost" && Array.isArray(data.line_items)) {
    const table = makeTable(
      ["Service", "Type/Class", "Cost"],
      data.line_items.map(li => [
        li.service?.toUpperCase() ?? "",
        li.instance_type ?? li.volume_type ?? li.storage_class ?? "",
        `$${li.monthly_cost?.toFixed(2)}`,
      ])
    );
    div.appendChild(table);
    return div;
  }

  // Generic key-value table for all other tools
  const skipKeys = new Set(["currency", "service"]);
  const rows = Object.entries(data)
    .filter(([k]) => !skipKeys.has(k) && k !== "requested")
    .map(([k, v]) => [
      k.replace(/_/g, " "),
      typeof v === "number" && k.includes("cost") ? `$${v.toFixed(2)}` : String(v),
    ]);

  if (rows.length) {
    div.appendChild(makeTable(["Field", "Value"], rows));
  }

  return div;
}

function makeTable(headers, rows) {
  const table = document.createElement("table");
  table.className = "result-table";
  const thead = table.createTHead();
  const hr = thead.insertRow();
  headers.forEach(h => {
    const th = document.createElement("th");
    th.textContent = h;
    hr.appendChild(th);
  });
  const tbody = table.createTBody();
  rows.forEach(cells => {
    const tr = tbody.insertRow();
    cells.forEach(c => {
      const td = tr.insertCell();
      td.textContent = c;
    });
  });
  return table;
}

/* ------------------------------------------------------------------ */
/*  Chat UI helpers                                                     */
/* ------------------------------------------------------------------ */

const chatWindow = document.getElementById("chatWindow");
const inputField = document.getElementById("userInput");
const sendBtn    = document.getElementById("sendBtn");

function appendMessage(role, contentNode) {
  const msg = document.createElement("div");
  msg.className = `message ${role}-message`;
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  if (typeof contentNode === "string") {
    bubble.textContent = contentNode;
  } else {
    bubble.appendChild(contentNode);
  }
  msg.appendChild(bubble);
  chatWindow.appendChild(msg);
  chatWindow.scrollTop = chatWindow.scrollHeight;
  return bubble;
}

function appendTyping() {
  const msg = document.createElement("div");
  msg.className = "message assistant-message";
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.innerHTML = '<span class="typing-dots"><span></span><span></span><span></span></span>';
  msg.appendChild(bubble);
  chatWindow.appendChild(msg);
  chatWindow.scrollTop = chatWindow.scrollHeight;
  return msg;
}

function appendError(text) {
  const msg = document.createElement("div");
  msg.className = "message assistant-message";
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  const err = document.createElement("div");
  err.className = "error-bubble";
  err.textContent = text;
  bubble.appendChild(err);
  msg.appendChild(bubble);
  chatWindow.appendChild(msg);
  chatWindow.scrollTop = chatWindow.scrollHeight;
}

/* ------------------------------------------------------------------ */
/*  Tool card panel                                                     */
/* ------------------------------------------------------------------ */

let _tools = [];

async function loadToolCards() {
  try {
    _tools = await listTools();
  } catch {
    _tools = [];
  }

  const container = document.getElementById("toolCards");
  container.innerHTML = "";
  _tools.forEach(tool => {
    const card = document.createElement("div");
    card.className = "tool-card";
    card.setAttribute("role", "button");
    card.setAttribute("tabindex", "0");
    card.innerHTML = `<span class="tool-name">${tool.name}</span><span class="tool-desc">${tool.description ?? ""}</span>`;
    card.addEventListener("click", () => openToolModal(tool));
    card.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") openToolModal(tool); });
    container.appendChild(card);
  });
}

/* ------------------------------------------------------------------ */
/*  Tool form modal                                                     */
/* ------------------------------------------------------------------ */

function openToolModal(tool) {
  const schema = tool.inputSchema ?? {};
  const props  = schema.properties ?? {};
  const req    = new Set(schema.required ?? []);

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";

  const modal = document.createElement("div");
  modal.className = "modal";
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");

  const h2 = document.createElement("h2");
  h2.textContent = tool.name;
  modal.appendChild(h2);

  const fieldEls = {};
  for (const [name, spec] of Object.entries(props)) {
    const group = document.createElement("div");
    group.className = "field-group";
    const label = document.createElement("label");
    label.htmlFor = `field-${name}`;
    label.textContent = name + (req.has(name) ? " *" : "");
    group.appendChild(label);

    let el;
    if (name === "storage_class") {
      el = document.createElement("select");
      ["STANDARD", "STANDARD_IA", "GLACIER"].forEach(cls => {
        const opt = document.createElement("option");
        opt.value = cls; opt.textContent = cls;
        el.appendChild(opt);
      });
    } else if (name === "volume_type") {
      el = document.createElement("select");
      ["gp3", "gp2", "io1", "st1", "sc1"].forEach(vt => {
        const opt = document.createElement("option");
        opt.value = vt; opt.textContent = vt;
        el.appendChild(opt);
      });
    } else {
      el = document.createElement("input");
      el.type = spec.type === "integer" || spec.type === "number" ? "number" : "text";
      if (spec.minimum !== undefined) el.min = spec.minimum;
      if (spec.default !== undefined) el.placeholder = `default: ${spec.default}`;
    }
    el.id = `field-${name}`;
    if (spec.default !== undefined && el.tagName !== "SELECT") el.value = spec.default;
    group.appendChild(el);

    if (spec.type) {
      const hint = document.createElement("div");
      hint.className = "field-hint";
      hint.textContent = spec.type + (spec.minimum !== undefined ? `, min ${spec.minimum}` : "");
      group.appendChild(hint);
    }

    fieldEls[name] = el;
    modal.appendChild(group);
  }

  const actions = document.createElement("div");
  actions.className = "modal-actions";

  const cancelBtn = document.createElement("button");
  cancelBtn.className = "btn btn-secondary";
  cancelBtn.textContent = "Cancel";
  cancelBtn.onclick = () => overlay.remove();

  const submitBtn = document.createElement("button");
  submitBtn.className = "btn btn-primary";
  submitBtn.textContent = "Call tool";
  submitBtn.onclick = () => {
    const args = {};
    for (const [name, el] of Object.entries(fieldEls)) {
      const raw = el.value.trim();
      if (raw === "") continue;
      const spec = props[name];
      if (spec?.type === "integer") args[name] = parseInt(raw, 10);
      else if (spec?.type === "number") args[name] = parseFloat(raw);
      else if (spec?.type === "object") {
        try { args[name] = JSON.parse(raw); } catch { args[name] = raw; }
      }
      else args[name] = raw;
    }
    overlay.remove();
    handleToolCall(tool.name, args);
  };

  actions.appendChild(cancelBtn);
  actions.appendChild(submitBtn);
  modal.appendChild(actions);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  // Close on backdrop click
  overlay.addEventListener("click", e => { if (e.target === overlay) overlay.remove(); });
  // Focus first input
  const firstInput = modal.querySelector("input, select");
  if (firstInput) firstInput.focus();
}

/* ------------------------------------------------------------------ */
/*  Invoke a tool and render the result                                 */
/* ------------------------------------------------------------------ */

async function handleToolCall(toolName, args) {
  const userText = `${toolName}(${JSON.stringify(args)})`;
  const pFrag = document.createDocumentFragment();
  const code = document.createElement("code");
  code.style.cssText = "font-family:monospace;font-size:13px;word-break:break-all;";
  code.textContent = userText;
  pFrag.appendChild(code);
  appendMessage("user", pFrag);

  const typing = appendTyping();
  sendBtn.disabled = true;

  try {
    const data = await callTool(toolName, args);
    typing.remove();
    const rendered = renderResult(toolName, data);
    appendMessage("assistant", rendered);
  } catch (err) {
    typing.remove();
    appendError(`Error: ${err.message}`);
  } finally {
    sendBtn.disabled = false;
  }
}

/* ------------------------------------------------------------------ */
/*  Free-text input handler                                             */
/* ------------------------------------------------------------------ */

async function handleUserText(text) {
  appendMessage("user", text);

  const intent = parseIntent(text);
  if (!intent) {
    const typing = appendTyping();
    // Fall back to listing tools so user knows what's available
    setTimeout(() => {
      typing.remove();
      const p = document.createElement("p");
      p.textContent = "I couldn't parse a tool from that. Try one of the quick-call buttons above, or phrase your question like:";
      const ul = document.createElement("ul");
      ul.style.cssText = "margin:6px 0 0 16px;font-size:13px;color:#8a90a8;";
      [
        '"m5.large × 3" – EC2 monthly cost',
        '"100 GB gp3 EBS" – EBS monthly cost',
        '"S3 500 GB GLACIER" – S3 storage cost',
        '"recommend 4 vCPU 16 GiB" – right-size',
      ].forEach(s => {
        const li = document.createElement("li");
        li.textContent = s;
        ul.appendChild(li);
      });
      const div = document.createElement("div");
      div.appendChild(p);
      div.appendChild(ul);
      appendMessage("assistant", div);
    }, 500);
    return;
  }

  const typing = appendTyping();
  sendBtn.disabled = true;
  try {
    const data = await callTool(intent.toolName, intent.args);
    typing.remove();
    const rendered = renderResult(intent.toolName, data);
    appendMessage("assistant", rendered);
  } catch (err) {
    typing.remove();
    appendError(`Error from MCP server: ${err.message}`);
  } finally {
    sendBtn.disabled = false;
  }
}

/* ------------------------------------------------------------------ */
/*  Wire up form                                                        */
/* ------------------------------------------------------------------ */

document.getElementById("inputForm").addEventListener("submit", async e => {
  e.preventDefault();
  const text = inputField.value.trim();
  if (!text) return;
  inputField.value = "";
  await handleUserText(text);
});

/* ------------------------------------------------------------------ */
/*  Boot                                                                */
/* ------------------------------------------------------------------ */

(async function init() {
  await loadToolCards();
})();
