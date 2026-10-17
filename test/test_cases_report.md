# Test Cases & Verification Report: PharmaTrust DApp

## Overview
This document contains the verification test matrix for the `PharmaTrust` smart contract, validating all state transitions, financial escrow calculations, and access control modifiers under valid, invalid, and unauthorized input conditions.

Both automated tests (`npx hardhat test`) and manual Ganache/Remix execution matrices are documented below.

## Automated Test Execution

Run the complete 12-case test suite using:
```bash
npm test
# or
npx hardhat test
```

### Automated Suite Results Summary
```text
  PharmaTrust Smart Contract Automated Test Suite
    TC-01: Valid Cargo Creation
      ✔ should allow shipper to create shipment, lock 0.05 ETH escrow and set status to Created
    TC-02: Valid Custody Acceptance & Bond Staking
      ✔ should allow designated carrier to stake exact collateral and transition status to InTransit
    TC-03: Valid Telemetry Logging (In-Bounds)
      ✔ should allow sensor to log safe temperature within range (-18°C) without breaching SLA
    TC-04: Autonomous SLA Breach Enforcement
      ✔ should automatically detect excursion (-2°C > -15°C max), breach SLA and route total 0.07 ETH to Shipper
    TC-05: Valid Pull-Pattern Fund Withdrawal
      ✔ should allow shipper to withdraw pending vault balance (0.07 ETH) securely
    TC-06: On-Time Delivery Confirmation
      ✔ should confirm delivery before deadline, set status to Delivered, and route full 0.07 ETH to Carrier vault
    TC-07: Delayed Delivery Penalty Enforcement
      ✔ should deduct late penalty (0.01 ETH) to Shipper and route net (0.06 ETH) to Carrier when delivered past deadline
    TC-08: Invalid Input - Inverted Temperature Thresholds
      ✔ should revert if minSafeTemp exceeds maxSafeTemp
    TC-09: Invalid Value - Underpaid Collateral Bond
      ✔ should revert if carrier sends less than required collateral
    TC-10: Unauthorized IoT Sensor Telemetry
      ✔ should revert if an unauthorized caller attempts to log telemetry
    TC-11: Unauthorized Delivery Confirmation
      ✔ should revert if carrier or third-party attempts to confirm delivery
    TC-12: Invalid State Machine Transition
      ✔ should revert if carrier tries to accept custody again while already InTransit

  12 passing (1s)
```

---

## Test Validation Matrix

| Test ID | Category | Target Function | Parameters / Caller | Expected Behavior | Observed Result | Status |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **TC-01** | Valid Input | `createShipment` | Caller: Shipper (Acc 0)<br>Fee: 0.05 ETH, Bond: 0.02 ETH<br>Min: -25°C, Max: -15°C | Shipment #1 created; 0.05 ETH locked in escrow; status is `Created` | Mined in block #1. Event `ShipmentCreated` emitted with parameters. | **PASS** |
| **TC-02** | Valid Payable | `acceptCustodyAndStake` | Caller: Carrier (Acc 1)<br>ID: 1, Value: 0.02 ETH | Exactly 0.02 ETH collateral locked; status transitions to `InTransit` | Collateral staked. UI status badge updates to `InTransit`. | **PASS** |
| **TC-03** | Valid Telemetry | `logTelemetry` | Caller: Sensor (Acc 2)<br>Temp: -18°C, Location: "NH48-Mile84" | Telemetry logged; within safe bounds; status remains `InTransit` | Mined in block #3. UI renders -18°C and location checkpoint. | **PASS** |
| **TC-04** | Autonomous SLA Breach | `logTelemetry` | Caller: Sensor (Acc 2)<br>Temp: -2°C (exceeds -15°C limit) | Excursion detected; status becomes `Breached`; 0.07 ETH routed to Shipper | Event `SLABreached` emitted. Shipper pull-vault balance becomes 0.07 ETH. | **PASS** |
| **TC-05** | Valid Pull Withdrawal | `withdrawVault` | Caller: Shipper (Acc 0)<br>Pending: 0.07 ETH | Contract sends 0.07 ETH to Shipper wallet; resets vault balance to 0 | Account 0 wallet balance increases by 0.07 ETH minus gas. Vault resets to 0. | **PASS** |
| **TC-06** | On-Time Delivery | `confirmDelivery` | Caller: Shipper (Acc 0)<br>Condition: Before deadline | Status becomes `Delivered`; 100% of payout (0.07 ETH) routed to Carrier vault | Status updates to `Delivered`. Zero penalty deducted from carrier. | **PASS** |
| **TC-07** | Delayed Delivery Penalty | `confirmDelivery` | Caller: Shipper (Acc 0)<br>Condition: After deadline | Late penalty (0.01 ETH) refunded to Shipper; net 0.06 ETH routed to Carrier | Penalty credited to Shipper vault; remaining payout credited to Carrier. | **PASS** |
| **TC-08** | Invalid Input (Temps) | `createShipment` | Min: -10°C, Max: -20°C (inverted) | Reverts: "Invalid Input: Max temp must exceed min temp" | Transaction reverted by EVM. No gas consumed for state alteration. | **PASS** |
| **TC-09** | Invalid Value (Underpaid) | `acceptCustodyAndStake` | Value: 0.005 ETH (Required: 0.02 ETH) | Reverts: "Invalid Value: Exact collateral bond required" | Reverted by EVM requirement check. No funds transferred. | **PASS** |
| **TC-10** | Unauthorized Sensor | `logTelemetry` | Caller: Unauthorized Signer (Acc 3) | Reverts: "Unauthorized: Caller is not authorized IoT sensor" | Modifier `onlySensor` halts execution immediately. | **PASS** |
| **TC-11** | Unauthorized Delivery | `confirmDelivery` | Caller: Carrier (Acc 1) | Reverts: "Unauthorized: Caller is not designated shipper" | Carrier cannot confirm their own delivery. | **PASS** |
| **TC-12** | Invalid State Transition | `acceptCustodyAndStake` | Calling when status is already `InTransit` | Reverts: "Invalid State: Action not allowed in current status" | State machine prevents re-staking on active shipment. | **PASS** |
