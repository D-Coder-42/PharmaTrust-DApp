# PharmaTrust DApp — Setup & Deployment Guide

This guide walks through configuring, compiling, deploying, and interacting with the PharmaTrust decentralized cold-chain application.

---

## 1. Prerequisites & Environment Setup

Ensure the following tools are installed on your machine:
* **Node.js:** v18.0.0 or higher ([nodejs.org](https://nodejs.org/))
* **Git:** Version control
* **Ganache:** Local Ethereum blockchain ([trufflesuite.com/ganache](https://trufflesuite.com/ganache/))
* **MetaMask:** Browser extension ([metamask.io](https://metamask.io/))
* **Browser:** Chrome, Brave, Firefox, or Edge

---

## 2. Smart Contract Compilation & Deployment

> [!IMPORTANT]
> **Stack Too Deep & EVM Compatibility Notice:**
> The `PharmaTrust.sol` contract manages a composite 16-variable `Shipment` struct and multi-stage escrow logic. Compiling without Yul Intermediate Representation (`viaIR`) will produce a `CompilerError: Stack too deep`. 
>
> **You MUST compile using the provided configuration file:** [`contracts/remix.config.js`](contracts/remix.config.js) or enable the corresponding settings in Remix IDE.

### Method A: Compiling & Deploying in Remix IDE (Recommended for Evaluation)

1. Open **[Remix IDE](https://remix.ethereum.org/)**.
2. In the File Explorer, upload or create:
   * `PharmaTrust.sol` (from `contracts/PharmaTrust.sol`)
   * `remix.config.js` (from `contracts/remix.config.js`)
3. **Configure the Solidity Compiler:**
   * Go to the **Solidity Compiler** tab on the left sidebar.
   * **Compiler Version:** Select `0.8.20+commit.a1b79de6`.
   * Open **Advanced Configurations**:
     * **Language:** Solidity
     * **EVM Version:** Select `paris` *(Essential: avoids `PUSH0` opcode incompatibility with Ganache).*
     * **Enable optimization:** Checked (Runs: `200`)
     * **viaIR (Yul intermediate representation):** Checked (`true`) *(Essential: fixes the `Stack too deep` compiler error).*
   * Click **Compile PharmaTrust.sol**.
4. **Deploy to Local Ganache Blockchain:**
   * Ensure Ganache is running on `http://127.0.0.1:7545`.
   * Open the **Deploy & Run Transactions** tab.
   * **Environment:** Select **Injected Provider - MetaMask**.
   * Approve the MetaMask connection to your local Ganache network.
   * **Contract:** Select `PharmaTrust - contracts/PharmaTrust.sol`.
   * Click the orange **Deploy** button.
   * Confirm the deployment transaction in MetaMask.
5. **Copy Contract Address:**
   * Copy the deployed contract address from Remix (e.g., `0x4b33F052c92b23a54b38d3885f8C39F9d9d61F`).

---

### Method B: Compiling & Testing via Hardhat (CLI)

The repository includes a pre-configured `hardhat.config.js` with `viaIR: true` and `evmVersion: "paris"` enabled.

1. **Install Project Dependencies:**
   ```bash
   npm install
   ```

2. **Run the Full Automated Test Suite:**
   ```bash
   npm test
   ```
   *(Executes all 12 validation test cases in under 400ms).*

3. **Deploy Contract via Hardhat Script:**
   ```bash
   npx hardhat run scripts/deploy.js --network localhost
   ```

---

## 3. Configuring MetaMask for Ganache

To interact with the DApp as different supply-chain participants, configure MetaMask with your local Ganache accounts:

### 3.1 Add the Ganache Network to MetaMask
* **Network Name:** `Ganache Local`
* **New RPC URL:** `http://127.0.0.1:7545`
* **Chain ID:** `1337` *(or `5777` if using default Ganache CLI)*
* **Currency Symbol:** `ETH`

### 3.2 Import Participant Accounts
From your Ganache dashboard, copy the private keys of at least 3 accounts and import them into MetaMask:
* **Account 1 (Shipper):** Funds escrow and confirms final delivery.
* **Account 2 (Carrier):** Stakes performance bond and accepts custody.
* **Account 3 (IoT Sensor):** Hardware oracle key authorized to log telemetry.

---

## 4. Running the Frontend DApp

1. **Start the Local Web Server:**
   ```bash
   npm start
   ```
   *The DApp will launch automatically in your browser at `http://localhost:3000`.*

2. **Connect MetaMask:**
   * Click **Connect MetaMask** in the top navigation bar.
   * Click **Import All** to authorize all three imported accounts.

3. **Verify Target Contract Address:**
   * Verify that the active contract address in the top bar matches your deployed address.
   * If you deployed a new contract in Remix, click **Change Target**, paste your new `0x...` address, and click **Apply**.

---

## 5. End-to-End Operational Walkthrough

### Step 1: Register Roles in the Directory (Tab 5)
* Navigate to **Tab 5: Directory & Roles**.
* Select Account 1 from the dropdown, choose role `Shipper`, label it `"PharmaCorp Shipper"`, and click **Save**.
* Select Account 2, choose role `Carrier`, label it `"Express Cold Fleet"`, and click **Save**.
* Select Account 3, choose role `IoT Sensor`, label it `"Truck #12 Sensor"`, and click **Save**.
*(These friendly labels will populate dropdowns across all tabs).*

### Step 2: Dispatch Cargo & Lock Escrow (Tab 1 — Shipper)
* Switch MetaMask active signer to **Shipper (Account 1)**.
* Open **Tab 1: Dispatch Cargo**.
* Enter shipment parameters:
  * **Cargo Description:** `mRNA Vaccine Vials Batch #104`
  * **Destination:** `ColdHub Mumbai Terminal 2`
  * **Designated Carrier:** Select your registered Carrier from the dropdown.
  * **IoT Sensor:** Select your registered Sensor from the dropdown.
  * **Safe Temperature Limits:** Min `-25°C`, Max `-15°C`.
  * **Shipping Fee Escrow:** `0.05 ETH`.
  * **Required Carrier Bond:** `0.02 ETH`.
  * **Transit Duration:** `7200` seconds (2 hours).
  * **Late Delivery Penalty:** `0.01 ETH`.
* Click **Dispatch Cargo & Deposit Escrow** and confirm in MetaMask.

### Step 3: Accept Custody & Stake Bond (Tab 2 — Carrier)
* Switch MetaMask active signer to **Carrier (Account 2)**.
* Open **Tab 2: Accept Custody**.
* Enter Shipment ID `1` and click **Fetch Terms**.
  * The exact mandatory bond (`0.02 ETH`) will load directly from the on-chain contract state.
* Click **Stake Required Collateral & Accept Custody** and confirm the transaction in MetaMask.
* The shipment status updates to `InTransit`.

### Step 4: Stream IoT Telemetry (Tab 3 — IoT Sensor)
* Switch MetaMask active signer to **IoT Sensor (Account 3)**.
* Open **Tab 3: IoT Telemetry**.
* Enter Shipment ID `1`. The UI dynamically verifies the safe window (`[-25°C to -15°C]`).
* **Test Case A (Normal Ping):**
  * Temp: `-18°C`, Location: `Highway-NH48-Mile84`.
  * Click **Log Telemetry Ping to Blockchain**. Status remains `InTransit`.
* **Test Case B (SLA Excursion Breach):**
  * Temp: `-5°C` (violates `-15°C` maximum threshold), Location: `Highway-NH48-Mile140`.
  * Click **Log Telemetry Ping to Blockchain**.
  * The smart contract autonomously slashes the Carrier's collateral (`0.02 ETH`), refunds the Shipper's fee (`0.05 ETH`), and marks status as `Breached`.

### Step 5: Ledger Inspection & Pull-Vault Withdrawal (Tab 4)
* Open **Tab 4: Ledger & Settlement**.
* Enter Shipment ID `1` and click **Query Ledger** to inspect the full on-chain record.
* In the **Pull-Payment Vault** panel at the top:
  * If an SLA breach occurred, the Shipper's vault reflects `0.0700 ETH`.
  * If transit succeeded on-time, the Carrier's vault reflects `0.0700 ETH` (fee + bond refund).
* Switch your active signer to the credited account and click **Withdraw to Wallet** to claim funds securely into your MetaMask balance.

---

## 6. Troubleshooting & Common Issues

| Issue | Cause | Solution |
| :--- | :--- | :--- |
| **`CompilerError: Stack too deep`** | Yul IR optimization disabled during compilation. | In Remix, open Advanced Configurations, check **viaIR** (`true`), and enable Optimizer (`200 runs`). Or use the provided `remix.config.js`. |
| **`invalid opcode` or `missing revert data` on Ganache** | Solidity 0.8.20 emits `PUSH0` (Shanghai EVM), which older Ganache versions do not support. | Set EVM version to **`paris`** in Remix compiler settings or `hardhat.config.js`. |
| **`Unauthorized: Caller is not designated carrier`** | MetaMask active account does not match the carrier address assigned during dispatch. | Switch the active signer in MetaMask to the designated carrier address before calling `acceptCustodyAndStake`. |
| **`Transaction underpriced` or stuck nonces** | Ganache was restarted while MetaMask kept previous account nonce state. | In MetaMask, go to **Settings > Advanced > Clear activity tab data** to reset the nonce tracker. |
