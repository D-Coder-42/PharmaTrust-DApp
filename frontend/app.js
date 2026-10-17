// PharmaTrust DApp Logic (Ethers.js v6 & MetaMask)
// Fully dynamic: User-driven role directory, tab navigation, exact collateral sync, stowaway audit drawer.

const DEFAULT_CONTRACT_ADDRESS = "0x4b33F968f6eE34300990dD63fC77c06ea2E9d61F";
const OLD_BROKEN_ADDRESS = "0xF916D80feCF48AE2746437833FDB646BE864090a";

// Purge any stale broken address from localStorage
let saved = localStorage.getItem("PHARMATRUST_CONTRACT_ADDRESS");
if (saved && saved.toLowerCase() === OLD_BROKEN_ADDRESS.toLowerCase()) {
  localStorage.removeItem("PHARMATRUST_CONTRACT_ADDRESS");
  saved = null;
}

let CONTRACT_ADDRESS = (saved && ethers.isAddress(saved)) ? saved : DEFAULT_CONTRACT_ADDRESS;

const CONTRACT_ABI = [
  "function createShipment(string _cargoDescription, string _destination, address _carrier, address _iotSensorAddress, int256 _minSafeTemp, int256 _maxSafeTemp, uint256 _carrierCollateralRequired, uint256 _transitDurationSeconds, uint256 _latePenalty) external payable returns (uint256)",
  "function acceptCustodyAndStake(uint256 _id) external payable",
  "function logTelemetry(uint256 _id, int256 _currentTemp, string _currentLocation) external",
  "function confirmDelivery(uint256 _id) external",
  "function withdrawVault() external",
  "function pendingWithdrawals(address) external view returns (uint256)",
  "function getShipment(uint256 _id) external view returns (tuple(uint256 id, string cargoDescription, string destination, string lastRecordedLocation, address shipper, address carrier, address iotSensorAddress, int256 minSafeTemp, int256 maxSafeTemp, uint256 shippingFee, uint256 carrierCollateral, uint256 deliveryDeadline, uint256 latePenalty, int256 lastRecordedTemp, uint256 lastPingTimestamp, uint8 status))"
];

let provider = null;
let signer = null;
let contract = null;
let currentAccount = null;
let connectedAccounts = [];

// Role Directory: address.toLowerCase() -> { role, label, address }
let savedDir = localStorage.getItem("PHARMATRUST_ROLE_DIRECTORY");
let roleDirectory = {};
if (savedDir) {
  try {
    const parsed = JSON.parse(savedDir);
    const hasOldAuto = Object.values(parsed).some(v => v.label && v.label.includes("(Acc "));
    if (hasOldAuto) {
      localStorage.removeItem("PHARMATRUST_ROLE_DIRECTORY");
      roleDirectory = {};
    } else {
      roleDirectory = parsed;
    }
  } catch (_) {
    roleDirectory = {};
  }
}

// Purge any legacy attacker/auditor roles from saved roleDirectory
if (roleDirectory) {
  let directoryModified = false;
  Object.keys(roleDirectory).forEach(k => {
    const r = (roleDirectory[k].role || "").toLowerCase();
    const l = (roleDirectory[k].label || "").toLowerCase();
    if (r.includes("attacker") || r.includes("auditor") || l.includes("attacker") || l.includes("auditor")) {
      delete roleDirectory[k];
      directoryModified = true;
    }
  });
  if (directoryModified) {
    localStorage.setItem("PHARMATRUST_ROLE_DIRECTORY", JSON.stringify(roleDirectory));
  }
}

const STATUS_MAP = ["Created", "InTransit", "Delivered", "Breached", "Settled"];

// Tabs Navigation
function switchTab(tabId) {
  document.querySelectorAll(".tab-pane").forEach(pane => pane.classList.remove("active"));
  document.querySelectorAll(".tab-btn").forEach(btn => btn.classList.remove("active"));

  const targetPane = document.getElementById(tabId);
  const targetBtn = document.querySelector(`.tab-btn[data-tab="${tabId}"]`);
  if (targetPane) targetPane.classList.add("active");
  if (targetBtn) targetBtn.classList.add("active");
}

// Stowaway Audit Drawer Toggle
function toggleAuditDrawer() {
  const drawer = document.getElementById("stowawayDrawer");
  const toggleBtn = document.getElementById("stowawayToggleBtn");
  drawer.classList.toggle("hidden");
  if (drawer.classList.contains("hidden")) {
    toggleBtn.innerHTML = "Show Audit Stream &uarr;";
  } else {
    toggleBtn.innerHTML = "Hide Audit Stream &darr;";
  }
}

// Terminal Logger
function log(msg) {
  const consoleEl = document.getElementById("consoleLog");
  const stowawayLastLog = document.getElementById("stowawayLastLog");
  const time = new Date().toLocaleTimeString();
  
  if (stowawayLastLog) stowawayLastLog.innerText = `[${time}] ${msg}`;
  if (!consoleEl) return;
  
  consoleEl.innerHTML += `<div>> [${time}] ${msg}</div>`;
  consoleEl.scrollTop = consoleEl.scrollHeight;
}

function clearTerminal() {
  const consoleEl = document.getElementById("consoleLog");
  if (consoleEl) {
    consoleEl.innerHTML = `<div>> Ready.</div>`;
  }
}

// Non-blocking Toast Notifications (Click to dismiss)
function showToast(message, type = "info", duration = 4500) {
  const container = document.getElementById("toastContainer");
  if (!container) return;

  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;

  const iconMap = {
    success: "✓",
    error: "✕",
    warning: "!",
    info: "ℹ"
  };

  const titleMap = {
    success: "Success",
    error: "Contract / Transaction Alert",
    warning: "Input Required",
    info: "Notice"
  };

  toast.innerHTML = `
    <div class="toast-icon">${iconMap[type] || "ℹ"}</div>
    <div class="toast-content">
      <div class="toast-title">${titleMap[type] || "Notice"}</div>
      <div class="toast-body">${message}</div>
      <div class="toast-hint">Click to dismiss</div>
    </div>
    <button class="toast-close" title="Dismiss">&times;</button>
  `;

  let dismissed = false;
  const dismiss = () => {
    if (dismissed) return;
    dismissed = true;
    toast.classList.add("toast-hiding");
    setTimeout(() => {
      if (toast.parentElement) toast.remove();
    }, 200);
  };

  toast.onclick = dismiss;
  container.appendChild(toast);

  if (duration > 0) {
    setTimeout(dismiss, duration);
  }
}

// Override browser modal alert with sleek non-blocking toast
window.alert = function(msg) {
  showToast(msg, "info");
};

// Contract address management
function toggleContractEdit() {
  const drawer = document.getElementById("contractEditDrawer");
  drawer.classList.toggle("hidden");
  const input = document.getElementById("contractAddressInput");
  if (input) input.value = CONTRACT_ADDRESS;
}

function saveContractAddress() {
  const input = document.getElementById("contractAddressInput");
  const addr = input.value.trim();
  if (!ethers.isAddress(addr)) {
    showToast("Please enter a valid Ethereum address", "warning");
    return;
  }
  CONTRACT_ADDRESS = addr;
  localStorage.setItem("PHARMATRUST_CONTRACT_ADDRESS", addr);
  updateContractDisplay();
  
  if (signer) {
    contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, signer);
  }
  toggleContractEdit();
  log(`Contract target updated: ${CONTRACT_ADDRESS}`);
  showToast("Contract target updated to " + addr.slice(0, 8) + "...", "success");
  refreshVault();
  fetchShipment();
}

function updateContractDisplay() {
  const codeEl = document.getElementById("activeContractCode");
  if (codeEl) {
    codeEl.innerText = `${CONTRACT_ADDRESS.slice(0, 6)}...${CONTRACT_ADDRESS.slice(-4)}`;
    codeEl.title = CONTRACT_ADDRESS;
  }
}

// Initialize and Connect MetaMask
async function connectWallet() {
  if (!window.ethereum) {
    showToast("MetaMask not detected! Please install MetaMask extension.", "error", 6000);
    return;
  }

  try {
    provider = new ethers.BrowserProvider(window.ethereum);
    const accs = await window.ethereum.request({ method: "eth_requestAccounts" });
    if (!accs || accs.length === 0) throw new Error("No accounts authorized.");

    const allAuthorized = await window.ethereum.request({ method: "eth_accounts" });
    connectedAccounts = allAuthorized && allAuthorized.length > 0 ? allAuthorized : accs;

    // Default to the first account if none selected
    if (!currentAccount || !connectedAccounts.map(a => a.toLowerCase()).includes(currentAccount.toLowerCase())) {
      currentAccount = connectedAccounts[0];
    }

    signer = await provider.getSigner(currentAccount);
    contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, signer);

    // Refresh UI
    const connectBtn = document.getElementById("connectBtn");
    if (connectBtn) {
      connectBtn.innerText = "Connected";
      connectBtn.classList.add("btn-connected");
    }
    const balInfo = document.getElementById("walletBalInfo");
    if (balInfo) balInfo.classList.remove("hidden");

    renderActorDropdown();
    renderDirectoryTable();
    updateIdentityDisplay();
    populateParticipantDropdowns();
    populateRegistrationAccountSelect();

    await refreshBalance();
    await refreshVault();

    log(`Connected to MetaMask. Active actor: ${currentAccount}`);
    showToast(`Connected to MetaMask (${currentAccount.slice(0, 6)}...${currentAccount.slice(-4)})`, "success");
  } catch (err) {
    log(`Connection failed: ${err.message}`);
    showToast(`MetaMask connection failed: ${err.message}`, "error");
  }
}

// Request permission for all MetaMask accounts
async function requestAllAccounts() {
  if (!window.ethereum) return showToast("MetaMask not found.", "error");
  try {
    await window.ethereum.request({
      method: "wallet_requestPermissions",
      params: [{ eth_accounts: {} }]
    });
    await connectWallet();
  } catch (_) {
    log("Account authorization request closed.");
  }
}

// Populate the connected accounts picker in Tab 5 (Registration)
function populateRegistrationAccountSelect() {
  const sel = document.getElementById("regConnectedAccountSelect");
  if (!sel) return;
  sel.innerHTML = `<option value="">-- Choose from connected accounts --</option>`;
  connectedAccounts.forEach((acc, idx) => {
    const opt = document.createElement("option");
    opt.value = acc;
    opt.innerText = `Connected Account ${idx}: ${acc}`;
    sel.appendChild(opt);
  });
}

// Render the Active Actor dropdown (Zero auto-assuming)
function renderActorDropdown() {
  const dropdown = document.getElementById("accountDropdown");
  if (!dropdown) return;
  dropdown.innerHTML = "";

  connectedAccounts.forEach((acc, idx) => {
    const key = acc.toLowerCase();
    const info = roleDirectory[key];
    const shortAddr = `${acc.slice(0, 6)}...${acc.slice(-4)}`;

    const opt = document.createElement("option");
    opt.value = acc;
    if (info) {
      opt.innerText = `${info.label} [${info.role}] (${shortAddr})`;
    } else {
      opt.innerText = `Account ${idx} (${shortAddr}) [Unregistered]`;
    }
    if (acc.toLowerCase() === currentAccount.toLowerCase()) {
      opt.selected = true;
    }
    dropdown.appendChild(opt);
  });
}

// When actor is selected from the dropdown
async function onAccountDropdownChange(selectedAddr) {
  if (!selectedAddr || !provider) return;
  currentAccount = selectedAddr;
  signer = await provider.getSigner(currentAccount);
  contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, signer);

  updateIdentityDisplay();
  await refreshBalance();
  await refreshVault();
  log(`Active actor switched to: ${currentAccount}`);
}

// Update identity banners
function updateIdentityDisplay() {
  if (!currentAccount) return;
  const key = currentAccount.toLowerCase();
  const info = roleDirectory[key] || { role: "Unregistered", label: "Connected Account" };

  const roleEl = document.getElementById("roleBadge");
  const addrEl = document.getElementById("activeRoleAddress");

  if (roleEl) {
    roleEl.innerText = info.role;
    roleEl.className = "role-tag";
    if (info.role === "Shipper") roleEl.classList.add("role-shipper");
    else if (info.role === "Carrier") roleEl.classList.add("role-carrier");
    else if (info.role === "IoT Sensor") roleEl.classList.add("role-sensor");
  }

  if (addrEl) {
    const shortAddr = `${currentAccount.slice(0, 6)}...${currentAccount.slice(-4)}`;
    addrEl.innerText = shortAddr;
    addrEl.title = currentAccount;
  }
}

// Query live wallet ETH balance
async function refreshBalance() {
  if (!provider || !currentAccount) return;
  try {
    const bal = await provider.getBalance(currentAccount);
    const eth = parseFloat(ethers.formatEther(bal)).toFixed(3);
    const balEl = document.getElementById("walletBalInfo");
    if (balEl) balEl.innerText = `${eth} ETH`;
  } catch (_) {}
}

// Populate the Carrier and Sensor dropdowns with ONLY valid accounts
function populateParticipantDropdowns() {
  const carrierSelect = document.getElementById("carrierSelect");
  const sensorSelect = document.getElementById("sensorSelect");

  if (carrierSelect) {
    carrierSelect.innerHTML = `<option value="">-- Choose Registered Carrier --</option>`;
    Object.values(roleDirectory).forEach(entry => {
      if (entry.role === "Carrier") {
        const opt = document.createElement("option");
        opt.value = entry.address;
        opt.innerText = `${entry.label} (${entry.address.slice(0, 6)}...${entry.address.slice(-4)})`;
        carrierSelect.appendChild(opt);
      }
    });
  }

  if (sensorSelect) {
    sensorSelect.innerHTML = `<option value="">-- Choose Registered Sensor --</option>`;
    Object.values(roleDirectory).forEach(entry => {
      if (entry.role === "IoT Sensor") {
        const opt = document.createElement("option");
        opt.value = entry.address;
        opt.innerText = `${entry.label} (${entry.address.slice(0, 6)}...${entry.address.slice(-4)})`;
        sensorSelect.appendChild(opt);
      }
    });
  }
}

function onCarrierSelectChange(val) {
  const input = document.getElementById("shipCarrier");
  if (input && val) input.value = val;
}

function onSensorSelectChange(val) {
  const input = document.getElementById("shipSensor");
  if (input && val) input.value = val;
}

// Tab 5: Register an account in directory
function registerAccount() {
  const address = document.getElementById("regAddress").value.trim();
  const role = document.getElementById("regRole").value;
  const label = document.getElementById("regLabel").value.trim();

  if (!ethers.isAddress(address)) {
    showToast("Please enter a valid Ethereum hex address.", "warning");
    return;
  }
  if (!label) {
    showToast("Please enter an identifier / friendly name.", "warning");
    return;
  }

  roleDirectory[address.toLowerCase()] = { role, label, address };
  localStorage.setItem("PHARMATRUST_ROLE_DIRECTORY", JSON.stringify(roleDirectory));

  document.getElementById("regAddress").value = "";
  document.getElementById("regLabel").value = "";

  renderActorDropdown();
  renderDirectoryTable();
  populateParticipantDropdowns();
  updateIdentityDisplay();

  log(`Registered "${label}" as ${role}`);
  showToast(`Account successfully registered as ${role}!`, "success");
}

function removeDirectoryEntry(addrKey) {
  delete roleDirectory[addrKey.toLowerCase()];
  localStorage.setItem("PHARMATRUST_ROLE_DIRECTORY", JSON.stringify(roleDirectory));
  renderActorDropdown();
  renderDirectoryTable();
  populateParticipantDropdowns();
  updateIdentityDisplay();
  showToast("Account removed from directory", "info");
}

// Render Tab 5 directory list
function renderDirectoryTable() {
  const table = document.getElementById("directoryTable");
  if (!table) return;

  const entries = Object.values(roleDirectory);
  if (entries.length === 0) {
    table.innerHTML = `<div style="padding: 16px; color: var(--text-tertiary); text-align: center;">No accounts registered in directory.</div>`;
    return;
  }

  let html = `
    <div class="directory-row directory-header">
      <div>Identifier</div>
      <div>Role</div>
      <div>Address</div>
      <div>Action</div>
    </div>
  `;

  entries.forEach(e => {
    html += `
      <div class="directory-row">
        <div><strong>${e.label}</strong></div>
        <div><span class="badge-neutral">${e.role}</span></div>
        <div><code>${e.address}</code></div>
        <div><button class="btn-link" onclick="removeDirectoryEntry('${e.address}')">Remove</button></div>
      </div>
    `;
  });

  table.innerHTML = html;
}

// Helper to cleanly extract revert string without coalesce error
function extractRevertReason(err) {
  if (err.reason) return err.reason;
  if (err.shortMessage) return err.shortMessage;
  if (err.info && err.info.error && err.info.error.message) {
    return err.info.error.message.replace("VM Exception while processing transaction: revert ", "");
  }
  if (err.data && typeof err.data === "string") return err.data;
  if (err.message) {
    const match = err.message.match(/reverted with reason string '([^']+)'/);
    if (match) return match[1];
    const matchCustom = err.message.match(/reverted with custom error '([^']+)'/);
    if (matchCustom) return matchCustom[1];
    return err.message;
  }
  return "Transaction reverted by smart contract requirement.";
}

// Tab 1: Create Shipment (Shipper)
async function createShipment() {
  if (!contract) return showToast("Please connect MetaMask first!", "warning");
  try {
    const cargo = document.getElementById("shipCargo").value.trim();
    const dest = document.getElementById("shipDest").value.trim();
    const carrier = document.getElementById("shipCarrier").value.trim();
    const sensor = document.getElementById("shipSensor").value.trim();
    const minT = document.getElementById("shipMinTemp").value;
    const maxT = document.getElementById("shipMaxTemp").value;
    const fee = document.getElementById("shipFee").value;
    const bond = document.getElementById("shipBond").value;
    const duration = document.getElementById("shipDuration").value;
    const penalty = document.getElementById("shipLatePenalty").value;

    if (!cargo || !dest || !carrier || !sensor || minT === "" || maxT === "" || !fee || !bond || !duration || !penalty) {
      return showToast("Please fill in all required shipment fields.", "warning");
    }
    if (!ethers.isAddress(carrier) || !ethers.isAddress(sensor)) {
      return showToast("Carrier or Sensor address is not a valid 0x hex address.", "warning");
    }

    const feeWei = ethers.parseEther(fee);
    const bondWei = ethers.parseEther(bond);
    const penaltyWei = ethers.parseEther(penalty);

    log(`Simulating dispatch for "${cargo}"...`);

    // Pre-simulate using staticCall to eliminate coalesce errors
    try {
      await contract.createShipment.staticCall(
        cargo, dest, carrier, sensor, BigInt(minT), BigInt(maxT), bondWei, BigInt(duration), penaltyWei,
        { value: feeWei }
      );
    } catch (simErr) {
      const reason = extractRevertReason(simErr);
      log(`Dispatch Reverted: "${reason}"`);
      showToast(`Dispatch Reverted by Contract: ${reason}`, "error", 6000);
      return;
    }

    const tx = await contract.createShipment(
      cargo, dest, carrier, sensor, BigInt(minT), BigInt(maxT), bondWei, BigInt(duration), penaltyWei,
      { value: feeWei, gasLimit: 2000000n }
    );

    log(`Dispatch broadcast: ${tx.hash.slice(0, 14)}...`);
    await tx.wait();
    log(`Shipment created successfully on-chain!`);
    showToast("Shipment created & shipping escrow locked on-chain!", "success");

    await refreshBalance();
    switchTab("tab-ledger");
    document.getElementById("queryShipId").value = 1;
    await fetchShipment();
  } catch (err) {
    const reason = extractRevertReason(err);
    log(`Dispatch Failed: ${reason}`);
    showToast(`Dispatch Failed: ${reason}`, "error", 6000);
  }
}

// Tab 2: Carrier Sync Terms & Stake Collateral
async function syncCarrierShipmentTerms() {
  if (!contract) return;
  const id = document.getElementById("carrierShipId").value;
  if (!id || Number(id) <= 0) return;

  try {
    const s = await contract.getShipment(id);
    const preview = document.getElementById("carrierTermsPreview");
    preview.classList.remove("hidden");

    document.getElementById("previewCargo").innerText = s.cargoDescription;
    document.getElementById("previewStatus").innerText = STATUS_MAP[Number(s.status)];
    document.getElementById("previewCarrier").innerText = s.carrier;
    
    // Exact collateral required by this specific shipment!
    const exactBondEth = ethers.formatEther(s.carrierCollateral);
    document.getElementById("previewBond").innerText = `${exactBondEth} ETH`;

    // Automatically fill the stake input with the exact bond!
    document.getElementById("carrierStake").value = exactBondEth;
    document.getElementById("carrierStakeHint").innerText = `Exact required bond (${exactBondEth} ETH) auto-loaded from contract.`;

    log(`Loaded terms for Shipment #${id}: Required Bond = ${exactBondEth} ETH`);
  } catch (_) {
    document.getElementById("carrierTermsPreview").classList.add("hidden");
    document.getElementById("carrierStakeHint").innerText = `Shipment #${id} not found on-chain.`;
  }
}

async function acceptCustody() {
  if (!contract) return showToast("Please connect MetaMask first!", "warning");
  try {
    const id = document.getElementById("carrierShipId").value;
    const stake = document.getElementById("carrierStake").value;
    if (!id || !stake) return showToast("Please provide Shipment ID and Collateral Stake.", "warning");

    const stakeWei = ethers.parseEther(stake);

    log(`Simulating custody acceptance for Shipment #${id} (${stake} ETH bond)...`);

    // Simulate with staticCall
    try {
      await contract.acceptCustodyAndStake.staticCall(id, { value: stakeWei });
    } catch (simErr) {
      const reason = extractRevertReason(simErr);
      log(`Accept Custody Reverted: "${reason}"`);
      showToast(`Accept Custody Reverted: ${reason} (Ensure active actor is designated Carrier)`, "error", 6000);
      return;
    }

    const tx = await contract.acceptCustodyAndStake(id, { value: stakeWei, gasLimit: 2000000n });
    log(`Custody transaction sent: ${tx.hash.slice(0, 14)}...`);
    await tx.wait();
    log(`Custody accepted! Status: InTransit.`);
    showToast("Custody accepted and performance bond locked in escrow!", "success");

    await syncCarrierShipmentTerms();
    await refreshBalance();
  } catch (err) {
    const reason = extractRevertReason(err);
    log(`Accept Custody Failed: ${reason}`);
    showToast(`Accept Custody Failed: ${reason}`, "error", 6000);
  }
}

// Tab 3: Telemetry Oracle
async function syncSensorThreshold() {
  const slaDisp = document.getElementById("telemetrySlaDisplay");
  if (!slaDisp) return;
  const id = document.getElementById("sensorShipId").value;
  if (!id || Number(id) <= 0 || !contract) {
    slaDisp.innerText = "-- (enter ID to inspect)";
    return;
  }
  try {
    const s = await contract.getShipment(id);
    slaDisp.innerText = `[${s.minSafeTemp}°C to ${s.maxSafeTemp}°C] · ${STATUS_MAP[Number(s.status)]}`;
  } catch (_) {
    slaDisp.innerText = "Shipment not found on-chain";
  }
}

async function sendCustomPing() {
  const temp = document.getElementById("customPingTemp").value;
  const loc = document.getElementById("customPingLoc").value.trim();
  if (temp === "" || !loc) return showToast("Please enter both Temperature and Location Checkpoint.", "warning");
  await triggerTelemetry(Number(temp), loc);
}

async function triggerTelemetry(temp, loc) {
  if (!contract) return showToast("Please connect MetaMask first!", "warning");
  try {
    const id = document.getElementById("sensorShipId").value;
    if (!id) return showToast("Please enter target Shipment ID.", "warning");

    log(`Simulating telemetry ping (${temp}°C at "${loc}") for #${id}...`);

    // Simulate with staticCall to capture SLA breach or unauthorized revert cleanly
    try {
      await contract.logTelemetry.staticCall(id, BigInt(temp), loc);
    } catch (simErr) {
      const reason = extractRevertReason(simErr);
      log(`Telemetry Reverted: "${reason}"`);
      showToast(`Telemetry Reverted by Contract: ${reason}`, "error", 6000);
      return;
    }

    const tx = await contract.logTelemetry(id, BigInt(temp), loc, { gasLimit: 2000000n });
    log(`Telemetry sent: ${tx.hash.slice(0, 14)}...`);
    await tx.wait();
    log(`Telemetry logged! Temperature: ${temp}°C, Waypoint: ${loc}`);
    showToast(`Telemetry recorded on-chain: ${temp}°C at ${loc}`, "success");

    await refreshVault();
    await refreshBalance();
  } catch (err) {
    const reason = extractRevertReason(err);
    log(`Telemetry Failed: ${reason}`);
    showToast(`Telemetry Failed: ${reason}`, "error", 6000);
  }
}

// Tab 4: Confirm Delivery & Withdraw Vault
async function confirmDelivery() {
  if (!contract) return showToast("Please connect MetaMask first!", "warning");
  try {
    const id = document.getElementById("queryShipId").value;
    if (!id) return showToast("Please enter Shipment ID to confirm delivery.", "warning");

    log(`Simulating delivery confirmation for Shipment #${id}...`);

    // Simulate with staticCall
    try {
      await contract.confirmDelivery.staticCall(id);
    } catch (simErr) {
      const reason = extractRevertReason(simErr);
      log(`Confirm Delivery Reverted: "${reason}"`);
      showToast(`Confirm Delivery Reverted: ${reason} (Ensure active actor is designated Shipper)`, "error", 6000);
      return;
    }

    const tx = await contract.confirmDelivery(id, { gasLimit: 2000000n });
    log(`Confirm delivery broadcast: ${tx.hash.slice(0, 14)}...`);
    await tx.wait();
    log(`Delivery confirmed! Payout routed to pull-vault.`);
    showToast("Delivery confirmed! Payout routed to pull-payment vault.", "success");

    await fetchShipment();
    await refreshVault();
    await refreshBalance();
  } catch (err) {
    const reason = extractRevertReason(err);
    log(`Confirm Delivery Failed: ${reason}`);
    showToast(`Confirm Delivery Failed: ${reason}`, "error", 6000);
  }
}

async function withdrawVault() {
  if (!contract) return showToast("Please connect MetaMask first!", "warning");
  try {
    log("Executing pull withdrawal from vault...");

    // Simulate with staticCall
    try {
      await contract.withdrawVault.staticCall();
    } catch (simErr) {
      const reason = extractRevertReason(simErr);
      log(`Withdrawal Reverted: "${reason}"`);
      showToast(`Withdrawal Reverted: ${reason}`, "error", 6000);
      return;
    }

    const tx = await contract.withdrawVault({ gasLimit: 2000000n });
    log(`Withdrawal sent: ${tx.hash.slice(0, 14)}...`);
    await tx.wait();
    log("Withdrawal complete! Funds credited to wallet.");
    showToast("Funds successfully withdrawn to your wallet!", "success");

    await refreshVault();
    await refreshBalance();
  } catch (err) {
    const reason = extractRevertReason(err);
    log(`Withdrawal Failed: ${reason}`);
    showToast(`Withdrawal Failed: ${reason}`, "error", 6000);
  }
}

// Refresh Vault Balance
async function refreshVault() {
  if (!contract || !currentAccount) return;
  try {
    const bal = await contract.pendingWithdrawals(currentAccount);
    const formatted = ethers.formatEther(bal);
    const vaultEl = document.getElementById("vaultBalance");
    if (vaultEl) vaultEl.innerText = `${parseFloat(formatted).toFixed(4)} ETH`;
  } catch (_) {}
}

// Query Shipment
async function fetchShipment() {
  if (!contract) return;
  try {
    const id = document.getElementById("queryShipId").value;
    if (!id || Number(id) <= 0) return;

    const s = await contract.getShipment(id);
    const st = Number(s.status);
    const pingTime = Number(s.lastPingTimestamp) === 0 ? "None" : new Date(Number(s.lastPingTimestamp) * 1000).toLocaleTimeString();
    const deadlineTime = new Date(Number(s.deliveryDeadline) * 1000).toLocaleString();

    // Update telemetry SLA display in Tab 3 as well
    const slaDisp = document.getElementById("telemetrySlaDisplay");
    if (slaDisp) slaDisp.innerText = `[${s.minSafeTemp}°C to ${s.maxSafeTemp}°C]`;

    const box = document.getElementById("shipmentData");
    box.innerHTML = `
      <div class="ledger-line">
        <span class="ledger-label">Shipment ID</span>
        <span class="ledger-value">#${s.id}</span>
      </div>
      <div class="ledger-line">
        <span class="ledger-label">Status</span>
        <span class="ledger-value">${STATUS_MAP[st]}</span>
      </div>
      <div class="ledger-line">
        <span class="ledger-label">Cargo Description</span>
        <span class="ledger-value">${s.cargoDescription} &rarr; ${s.destination}</span>
      </div>
      <div class="ledger-line">
        <span class="ledger-label">Last Location Waypoint</span>
        <span class="ledger-value"><code>${s.lastRecordedLocation}</code></span>
      </div>
      <div class="ledger-line">
        <span class="ledger-label">Last Temperature</span>
        <span class="ledger-value"><strong>${s.lastRecordedTemp}°C</strong> (${pingTime})</span>
      </div>
      <div class="ledger-line">
        <span class="ledger-label">Safe SLA Thresholds</span>
        <span class="ledger-value">[${s.minSafeTemp}°C to ${s.maxSafeTemp}°C]</span>
      </div>
      <div class="ledger-line">
        <span class="ledger-label">Delivery Deadline</span>
        <span class="ledger-value">${deadlineTime}</span>
      </div>
      <div class="ledger-line">
        <span class="ledger-label">Locked Escrow / Required Bond</span>
        <span class="ledger-value">${ethers.formatEther(s.shippingFee)} ETH / ${ethers.formatEther(s.carrierCollateral)} ETH</span>
      </div>
      <div class="ledger-line">
        <span class="ledger-label">Shipper (Acc)</span>
        <span class="ledger-value"><code>${s.shipper}</code></span>
      </div>
      <div class="ledger-line">
        <span class="ledger-label">Designated Carrier</span>
        <span class="ledger-value"><code>${s.carrier}</code></span>
      </div>
      <div class="ledger-line">
        <span class="ledger-label">Authorized IoT Oracle</span>
        <span class="ledger-value"><code>${s.iotSensorAddress}</code></span>
      </div>
    `;
  } catch (_) {
    document.getElementById("shipmentData").innerHTML = `
      <div class="ledger-empty">Shipment #${document.getElementById("queryShipId").value} not found on-chain.</div>
    `;
  }
}

// Auto-reconnect & listeners
window.addEventListener("DOMContentLoaded", () => {
  updateContractDisplay();
  renderDirectoryTable();

  if (window.ethereum) {
    window.ethereum.request({ method: "eth_accounts" }).then(accounts => {
      if (accounts && accounts.length > 0) {
        connectWallet();
      }
    });

    window.ethereum.on("accountsChanged", (accounts) => {
      if (accounts && accounts.length > 0) {
        connectedAccounts = accounts;
        currentAccount = accounts[0];
        connectWallet();
      }
    });

    window.ethereum.on("chainChanged", () => connectWallet());
  }
});
