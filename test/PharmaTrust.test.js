const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("PharmaTrust Smart Contract Automated Test Suite", function () {
  let PharmaTrust;
  let pharmaTrust;
  let shipper, carrier, sensor, attacker, other;

  // Standard shipment parameters
  const cargoDesc = "mRNA Vaccine Vials Batch #104";
  const destination = "ColdHub-Bengaluru-Terminal2";
  const minTemp = -25;
  const maxTemp = -15;
  const shippingFee = ethers.parseEther("0.05");
  const carrierCollateral = ethers.parseEther("0.02");
  const transitDuration = 300; // 300 seconds
  const latePenalty = ethers.parseEther("0.01");

  // Status enum mapping
  const Status = {
    Created: 0,
    InTransit: 1,
    Delivered: 2,
    Breached: 3,
    Settled: 4,
  };

  beforeEach(async function () {
    [shipper, carrier, sensor, attacker, other] = await ethers.getSigners();
    PharmaTrust = await ethers.getContractFactory("PharmaTrust");
    pharmaTrust = await PharmaTrust.deploy();
    await pharmaTrust.waitForDeployment();
  });

  describe("TC-01: Valid Cargo Creation", function () {
    it("should allow shipper to create shipment, lock 0.05 ETH escrow and set status to Created", async function () {
      const tx = await pharmaTrust.connect(shipper).createShipment(
        cargoDesc,
        destination,
        carrier.address,
        sensor.address,
        minTemp,
        maxTemp,
        carrierCollateral,
        transitDuration,
        latePenalty,
        { value: shippingFee }
      );

      await expect(tx)
        .to.emit(pharmaTrust, "ShipmentCreated")
        .withArgs(1, cargoDesc, destination, (await time.latest()) + transitDuration, shippingFee);

      const shipment = await pharmaTrust.getShipment(1);
      expect(shipment.id).to.equal(1);
      expect(shipment.cargoDescription).to.equal(cargoDesc);
      expect(shipment.destination).to.equal(destination);
      expect(shipment.shipper).to.equal(shipper.address);
      expect(shipment.carrier).to.equal(carrier.address);
      expect(shipment.iotSensorAddress).to.equal(sensor.address);
      expect(shipment.shippingFee).to.equal(shippingFee);
      expect(shipment.carrierCollateral).to.equal(carrierCollateral);
      expect(shipment.status).to.equal(Status.Created);
      expect(await ethers.provider.getBalance(await pharmaTrust.getAddress())).to.equal(shippingFee);
    });
  });

  describe("TC-02: Valid Custody Acceptance & Bond Staking", function () {
    beforeEach(async function () {
      await pharmaTrust.connect(shipper).createShipment(
        cargoDesc,
        destination,
        carrier.address,
        sensor.address,
        minTemp,
        maxTemp,
        carrierCollateral,
        transitDuration,
        latePenalty,
        { value: shippingFee }
      );
    });

    it("should allow designated carrier to stake exact collateral and transition status to InTransit", async function () {
      const tx = await pharmaTrust.connect(carrier).acceptCustodyAndStake(1, {
        value: carrierCollateral,
      });

      await expect(tx)
        .to.emit(pharmaTrust, "CustodyAccepted")
        .withArgs(1, carrier.address, carrierCollateral);

      const shipment = await pharmaTrust.getShipment(1);
      expect(shipment.status).to.equal(Status.InTransit);
      expect(await ethers.provider.getBalance(await pharmaTrust.getAddress())).to.equal(
        shippingFee + carrierCollateral
      );
    });
  });

  describe("TC-03: Valid Telemetry Logging (In-Bounds)", function () {
    beforeEach(async function () {
      await pharmaTrust.connect(shipper).createShipment(
        cargoDesc,
        destination,
        carrier.address,
        sensor.address,
        minTemp,
        maxTemp,
        carrierCollateral,
        transitDuration,
        latePenalty,
        { value: shippingFee }
      );
      await pharmaTrust.connect(carrier).acceptCustodyAndStake(1, { value: carrierCollateral });
    });

    it("should allow sensor to log safe temperature within range (-18°C) without breaching SLA", async function () {
      const safeTemp = -18;
      const location = "Highway-NH48-Mile84";

      const tx = await pharmaTrust.connect(sensor).logTelemetry(1, safeTemp, location);
      await expect(tx)
        .to.emit(pharmaTrust, "TelemetryLogged")
        .withArgs(1, safeTemp, location, await time.latest());

      const shipment = await pharmaTrust.getShipment(1);
      expect(shipment.lastRecordedTemp).to.equal(safeTemp);
      expect(shipment.lastRecordedLocation).to.equal(location);
      expect(shipment.status).to.equal(Status.InTransit);
      expect(await pharmaTrust.pendingWithdrawals(shipper.address)).to.equal(0);
    });
  });

  describe("TC-04: Autonomous SLA Breach Enforcement", function () {
    beforeEach(async function () {
      await pharmaTrust.connect(shipper).createShipment(
        cargoDesc,
        destination,
        carrier.address,
        sensor.address,
        minTemp,
        maxTemp,
        carrierCollateral,
        transitDuration,
        latePenalty,
        { value: shippingFee }
      );
      await pharmaTrust.connect(carrier).acceptCustodyAndStake(1, { value: carrierCollateral });
    });

    it("should automatically detect excursion (-2°C > -15°C max), breach SLA and route total 0.07 ETH to Shipper", async function () {
      const breachTemp = -2;
      const breachLocation = "Unauthorized-Detour-Lot";

      const tx = await pharmaTrust.connect(sensor).logTelemetry(1, breachTemp, breachLocation);

      await expect(tx)
        .to.emit(pharmaTrust, "SLABreached")
        .withArgs(1, breachTemp, carrierCollateral);

      const shipment = await pharmaTrust.getShipment(1);
      expect(shipment.status).to.equal(Status.Breached);

      // Shipper pull-vault gets shippingFee (0.05) + carrierCollateral (0.02) = 0.07 ETH
      const totalRefundAndPenalty = shippingFee + carrierCollateral;
      expect(await pharmaTrust.pendingWithdrawals(shipper.address)).to.equal(totalRefundAndPenalty);
    });
  });

  describe("TC-05: Valid Pull-Pattern Fund Withdrawal", function () {
    beforeEach(async function () {
      await pharmaTrust.connect(shipper).createShipment(
        cargoDesc,
        destination,
        carrier.address,
        sensor.address,
        minTemp,
        maxTemp,
        carrierCollateral,
        transitDuration,
        latePenalty,
        { value: shippingFee }
      );
      await pharmaTrust.connect(carrier).acceptCustodyAndStake(1, { value: carrierCollateral });
      await pharmaTrust.connect(sensor).logTelemetry(1, -2, "Unauthorized-Detour-Lot");
    });

    it("should allow shipper to withdraw pending vault balance (0.07 ETH) securely", async function () {
      const pendingBefore = await pharmaTrust.pendingWithdrawals(shipper.address);
      expect(pendingBefore).to.equal(shippingFee + carrierCollateral);

      const initialShipperBal = await ethers.provider.getBalance(shipper.address);
      const tx = await pharmaTrust.connect(shipper).withdrawVault();
      const receipt = await tx.wait();
      const gasCost = receipt.gasUsed * receipt.gasPrice;

      await expect(tx)
        .to.emit(pharmaTrust, "FundsWithdrawn")
        .withArgs(shipper.address, pendingBefore);

      expect(await pharmaTrust.pendingWithdrawals(shipper.address)).to.equal(0);
      const finalShipperBal = await ethers.provider.getBalance(shipper.address);
      expect(finalShipperBal).to.equal(initialShipperBal + pendingBefore - gasCost);
    });
  });

  describe("TC-06: On-Time Delivery Confirmation", function () {
    beforeEach(async function () {
      await pharmaTrust.connect(shipper).createShipment(
        cargoDesc,
        destination,
        carrier.address,
        sensor.address,
        minTemp,
        maxTemp,
        carrierCollateral,
        transitDuration,
        latePenalty,
        { value: shippingFee }
      );
      await pharmaTrust.connect(carrier).acceptCustodyAndStake(1, { value: carrierCollateral });
      await pharmaTrust.connect(sensor).logTelemetry(1, -20, "Highway-NH48-Mile120");
    });

    it("should confirm delivery before deadline, set status to Delivered, and route full 0.07 ETH to Carrier vault", async function () {
      const fullPayout = shippingFee + carrierCollateral;

      const tx = await pharmaTrust.connect(shipper).confirmDelivery(1);
      await expect(tx)
        .to.emit(pharmaTrust, "ShipmentDelivered")
        .withArgs(1, fullPayout, 0);

      const shipment = await pharmaTrust.getShipment(1);
      expect(shipment.status).to.equal(Status.Delivered);
      expect(await pharmaTrust.pendingWithdrawals(carrier.address)).to.equal(fullPayout);
      expect(await pharmaTrust.pendingWithdrawals(shipper.address)).to.equal(0);
    });
  });

  describe("TC-07: Delayed Delivery Penalty Enforcement", function () {
    beforeEach(async function () {
      await pharmaTrust.connect(shipper).createShipment(
        cargoDesc,
        destination,
        carrier.address,
        sensor.address,
        minTemp,
        maxTemp,
        carrierCollateral,
        transitDuration,
        latePenalty,
        { value: shippingFee }
      );
      await pharmaTrust.connect(carrier).acceptCustodyAndStake(1, { value: carrierCollateral });
    });

    it("should deduct late penalty (0.01 ETH) to Shipper and route net (0.06 ETH) to Carrier when delivered past deadline", async function () {
      // Advance time past deadline (transitDuration + 50s)
      await time.increase(transitDuration + 50);

      const netCarrierPayout = shippingFee + carrierCollateral - latePenalty;

      const tx = await pharmaTrust.connect(shipper).confirmDelivery(1);
      await expect(tx)
        .to.emit(pharmaTrust, "ShipmentDelivered")
        .withArgs(1, netCarrierPayout, latePenalty);

      const shipment = await pharmaTrust.getShipment(1);
      expect(shipment.status).to.equal(Status.Delivered);
      expect(await pharmaTrust.pendingWithdrawals(shipper.address)).to.equal(latePenalty);
      expect(await pharmaTrust.pendingWithdrawals(carrier.address)).to.equal(netCarrierPayout);
    });
  });

  describe("TC-08: Invalid Input - Inverted Temperature Thresholds", function () {
    it("should revert if minSafeTemp exceeds maxSafeTemp", async function () {
      await expect(
        pharmaTrust.connect(shipper).createShipment(
          cargoDesc,
          destination,
          carrier.address,
          sensor.address,
          -10, // min > max inverted
          -20, // max
          carrierCollateral,
          transitDuration,
          latePenalty,
          { value: shippingFee }
        )
      ).to.be.revertedWith("Invalid Input: Max temp must exceed min temp");
    });
  });

  describe("TC-09: Invalid Value - Underpaid Collateral Bond", function () {
    beforeEach(async function () {
      await pharmaTrust.connect(shipper).createShipment(
        cargoDesc,
        destination,
        carrier.address,
        sensor.address,
        minTemp,
        maxTemp,
        carrierCollateral,
        transitDuration,
        latePenalty,
        { value: shippingFee }
      );
    });

    it("should revert if carrier sends less than required collateral", async function () {
      const underpaidAmount = ethers.parseEther("0.005");
      await expect(
        pharmaTrust.connect(carrier).acceptCustodyAndStake(1, { value: underpaidAmount })
      ).to.be.revertedWith("Invalid Value: Exact collateral bond required");
    });
  });

  describe("TC-10: Unauthorized IoT Sensor Telemetry", function () {
    beforeEach(async function () {
      await pharmaTrust.connect(shipper).createShipment(
        cargoDesc,
        destination,
        carrier.address,
        sensor.address,
        minTemp,
        maxTemp,
        carrierCollateral,
        transitDuration,
        latePenalty,
        { value: shippingFee }
      );
      await pharmaTrust.connect(carrier).acceptCustodyAndStake(1, { value: carrierCollateral });
    });

    it("should revert if an unauthorized caller attempts to log telemetry", async function () {
      await expect(
        pharmaTrust.connect(attacker).logTelemetry(1, -18, "Unauthorized-Location")
      ).to.be.revertedWith("Unauthorized: Caller is not authorized IoT sensor");
    });
  });

  describe("TC-11: Unauthorized Delivery Confirmation", function () {
    beforeEach(async function () {
      await pharmaTrust.connect(shipper).createShipment(
        cargoDesc,
        destination,
        carrier.address,
        sensor.address,
        minTemp,
        maxTemp,
        carrierCollateral,
        transitDuration,
        latePenalty,
        { value: shippingFee }
      );
      await pharmaTrust.connect(carrier).acceptCustodyAndStake(1, { value: carrierCollateral });
    });

    it("should revert if carrier or third-party attempts to confirm delivery", async function () {
      await expect(
        pharmaTrust.connect(carrier).confirmDelivery(1)
      ).to.be.revertedWith("Unauthorized: Caller is not designated shipper");

      await expect(
        pharmaTrust.connect(attacker).confirmDelivery(1)
      ).to.be.revertedWith("Unauthorized: Caller is not designated shipper");
    });
  });

  describe("TC-12: Invalid State Machine Transition", function () {
    beforeEach(async function () {
      await pharmaTrust.connect(shipper).createShipment(
        cargoDesc,
        destination,
        carrier.address,
        sensor.address,
        minTemp,
        maxTemp,
        carrierCollateral,
        transitDuration,
        latePenalty,
        { value: shippingFee }
      );
      await pharmaTrust.connect(carrier).acceptCustodyAndStake(1, { value: carrierCollateral });
    });

    it("should revert if carrier tries to accept custody again while already InTransit", async function () {
      await expect(
        pharmaTrust.connect(carrier).acceptCustodyAndStake(1, { value: carrierCollateral })
      ).to.be.revertedWith("Invalid State: Action not allowed in current status");
    });
  });
});
