// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title PharmaTrust
 * @author PharmaTrust Core Architecture Team
 * @notice Autonomous cold-chain SLA escrow protocol with inbound IoT hardware oracle verification,
 *         cryptographic performance bonding, automated breach slashing, and delay penalties.
 * @dev Implements an explicit 5-stage finite state machine and the pull-over-push payment pattern
 *      for reentrancy-safe escrow disbursement.
 */
contract PharmaTrust {
    /// @notice Address of the contract deployer (retained for protocol provenance and audit trail)
    address public immutable platformOwner;

    /// @notice Global counter tracking the total number of shipments initialized on-chain
    uint256 public shipmentCounter;

    /**
     * @notice Operational lifecycle states for cargo shipments
     * @value Created Initial state after shipper deposits freight fee; awaiting carrier custody acceptance
     * @value InTransit Active transit state; carrier bond locked; IoT sensor streaming telemetry
     * @value Delivered Cargo successfully received; final settlement calculated and routed to vault
     * @value Breached Thermal SLA violated; carrier collateral slashed and routed to shipper vault
     * @value Settled Final terminal state (reserved for archival tracking)
     */
    enum ShipmentStatus {
        Created,
        InTransit,
        Delivered,
        Breached,
        Settled
    }

    /**
     * @notice Comprehensive data record representing an on-chain shipment agreement
     */
    struct Shipment {
        uint256 id;
        string cargoDescription;
        string destination;
        string lastRecordedLocation;
        address payable shipper;
        address payable carrier;
        address iotSensorAddress;
        int256 minSafeTemp;
        int256 maxSafeTemp;
        uint256 shippingFee;
        uint256 carrierCollateral;
        uint256 deliveryDeadline;
        uint256 latePenalty;
        int256 lastRecordedTemp;
        uint256 lastPingTimestamp;
        ShipmentStatus status;
    }

    /// @notice Mapping from shipment ID to full shipment state record
    mapping(uint256 => Shipment) public shipments;

    /// @notice Isolated pull-payment vault balances for secure beneficiary withdrawals
    mapping(address => uint256) public pendingWithdrawals;

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    event ShipmentCreated(
        uint256 indexed id,
        string cargo,
        string destination,
        uint256 deadline,
        uint256 fee
    );

    event CustodyAccepted(
        uint256 indexed id,
        address indexed carrier,
        uint256 collateralStaked
    );

    event TelemetryLogged(
        uint256 indexed id,
        int256 currentTemp,
        string location,
        uint256 timestamp
    );

    event SLABreached(
        uint256 indexed id,
        int256 breachTemp,
        uint256 collateralSlashed
    );

    event ShipmentDelivered(
        uint256 indexed id,
        uint256 carrierPayout,
        uint256 delayPenaltyDeducted
    );

    event FundsWithdrawn(
        address indexed user,
        uint256 amount
    );

    // -------------------------------------------------------------------------
    // Access Control & State Modifiers
    // -------------------------------------------------------------------------

    modifier onlyShipper(uint256 _id) {
        require(msg.sender == shipments[_id].shipper, "Unauthorized: Caller is not designated shipper");
        _;
    }

    modifier onlyCarrier(uint256 _id) {
        require(msg.sender == shipments[_id].carrier, "Unauthorized: Caller is not designated carrier");
        _;
    }

    modifier onlySensor(uint256 _id) {
        require(msg.sender == shipments[_id].iotSensorAddress, "Unauthorized: Caller is not authorized IoT sensor");
        _;
    }

    modifier inStatus(uint256 _id, ShipmentStatus _status) {
        require(shipments[_id].status == _status, "Invalid State: Action not allowed in current status");
        _;
    }

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    constructor() {
        platformOwner = msg.sender;
    }

    // -------------------------------------------------------------------------
    // External Mutating Functions
    // -------------------------------------------------------------------------

    /**
     * @notice Initializes a new shipment escrow agreement with custom SLA parameters.
     * @dev Locks the shipper's freight fee in contract escrow and computes an immutable delivery deadline.
     * @param _cargoDescription Human-readable description or batch ID of the pharmaceutical cargo.
     * @param _destination Destination facility or terminal identifier.
     * @param _carrier Address of the logistics provider authorized to accept custody.
     * @param _iotSensorAddress Public address of the physical telematics device authorized to stream sensor data.
     * @param _minSafeTemp Minimum allowable temperature in degrees Celsius (supports sub-zero).
     * @param _maxSafeTemp Maximum allowable temperature in degrees Celsius.
     * @param _carrierCollateralRequired Amount of performance bond (in Wei) the carrier must stake to accept custody.
     * @param _transitDurationSeconds Maximum duration allowance (in seconds) for delivery.
     * @param _latePenalty Financial penalty (in Wei) deducted from carrier payout if delivered past deadline.
     * @return uint256 The unique identifier of the newly initialized shipment.
     */
    function createShipment(
        string calldata _cargoDescription,
        string calldata _destination,
        address payable _carrier,
        address _iotSensorAddress,
        int256 _minSafeTemp,
        int256 _maxSafeTemp,
        uint256 _carrierCollateralRequired,
        uint256 _transitDurationSeconds,
        uint256 _latePenalty
    ) external payable returns (uint256) {
        require(bytes(_cargoDescription).length > 0, "Invalid Input: Cargo description required");
        require(bytes(_destination).length > 0, "Invalid Input: Destination required");
        require(_carrier != address(0) && _carrier != msg.sender, "Invalid Input: Invalid carrier address");
        require(_iotSensorAddress != address(0), "Invalid Input: Invalid sensor address");
        require(_maxSafeTemp > _minSafeTemp, "Invalid Input: Max temp must exceed min temp");
        require(msg.value > 0, "Invalid Input: Shipping fee escrow required");
        require(_latePenalty <= _carrierCollateralRequired, "Invalid Input: Late penalty exceeds collateral");
        require(_transitDurationSeconds >= 60, "Invalid Input: Transit duration must be >= 60s");

        shipmentCounter++;
        uint256 deadline = block.timestamp + _transitDurationSeconds;

        shipments[shipmentCounter] = Shipment({
            id: shipmentCounter,
            cargoDescription: _cargoDescription,
            destination: _destination,
            lastRecordedLocation: "Origin Warehouse",
            shipper: payable(msg.sender),
            carrier: _carrier,
            iotSensorAddress: _iotSensorAddress,
            minSafeTemp: _minSafeTemp,
            maxSafeTemp: _maxSafeTemp,
            shippingFee: msg.value,
            carrierCollateral: _carrierCollateralRequired,
            deliveryDeadline: deadline,
            latePenalty: _latePenalty,
            lastRecordedTemp: 0,
            lastPingTimestamp: 0,
            status: ShipmentStatus.Created
        });

        emit ShipmentCreated(shipmentCounter, _cargoDescription, _destination, deadline, msg.value);
        return shipmentCounter;
    }

    /**
     * @notice Carrier stakes performance bond and assumes physical custody of the shipment.
     * @dev Validates that msg.value matches exact required performance bond. Advances status to InTransit.
     * @param _id Unique identifier of the target shipment.
     */
    function acceptCustodyAndStake(uint256 _id)
        external
        payable
        onlyCarrier(_id)
        inStatus(_id, ShipmentStatus.Created)
    {
        Shipment storage s = shipments[_id];
        require(msg.value == s.carrierCollateral, "Invalid Value: Exact collateral bond required");

        s.status = ShipmentStatus.InTransit;
        emit CustodyAccepted(_id, msg.sender, msg.value);
    }

    /**
     * @notice Ingests real-time environmental telemetry from the authorized hardware oracle.
     * @dev Evaluates ambient temperature against safe limits. If an excursion is detected,
     *      the contract autonomously marks status as Breached, slashes carrier collateral,
     *      and refunds the shipper by crediting both amounts into pendingWithdrawals[shipper].
     * @param _id Target shipment identifier.
     * @param _currentTemp Ambient temperature reading in degrees Celsius.
     * @param _currentLocation Geographic waypoint or checkpoint identifier.
     */
    function logTelemetry(
        uint256 _id,
        int256 _currentTemp,
        string calldata _currentLocation
    )
        external
        onlySensor(_id)
        inStatus(_id, ShipmentStatus.InTransit)
    {
        require(bytes(_currentLocation).length > 0, "Invalid Input: Location cannot be empty");

        Shipment storage s = shipments[_id];
        s.lastRecordedTemp = _currentTemp;
        s.lastRecordedLocation = _currentLocation;
        s.lastPingTimestamp = block.timestamp;

        emit TelemetryLogged(_id, _currentTemp, _currentLocation, block.timestamp);

        if (_currentTemp < s.minSafeTemp || _currentTemp > s.maxSafeTemp) {
            s.status = ShipmentStatus.Breached;
            uint256 totalRefundAndPenalty = s.shippingFee + s.carrierCollateral;

            pendingWithdrawals[s.shipper] += totalRefundAndPenalty;
            emit SLABreached(_id, _currentTemp, s.carrierCollateral);
        }
    }

    /**
     * @notice Confirms successful delivery, evaluates punctuality against deadline, and routes payout.
     * @dev If delivered after deliveryDeadline, latePenalty is deducted from carrier payout and refunded
     *      to shipper. Net amounts are credited to pendingWithdrawals.
     * @param _id Target shipment identifier.
     */
    function confirmDelivery(uint256 _id)
        external
        onlyShipper(_id)
        inStatus(_id, ShipmentStatus.InTransit)
    {
        Shipment storage s = shipments[_id];
        s.status = ShipmentStatus.Delivered;

        uint256 penaltyDeducted = 0;
        uint256 carrierPayout = s.shippingFee + s.carrierCollateral;

        if (block.timestamp > s.deliveryDeadline) {
            penaltyDeducted = s.latePenalty;
            carrierPayout -= penaltyDeducted;
            pendingWithdrawals[s.shipper] += penaltyDeducted;
        }

        pendingWithdrawals[s.carrier] += carrierPayout;

        emit ShipmentDelivered(_id, carrierPayout, penaltyDeducted);
    }

    /**
     * @notice Pull-pattern withdrawal mechanism isolating beneficiary payouts from state transitions.
     * @dev Implements Checks-Effects-Interactions: zeroes pending balance before external ETH transfer.
     */
    function withdrawVault() external {
        uint256 amount = pendingWithdrawals[msg.sender];
        require(amount > 0, "Invalid Request: No withdrawable funds");

        pendingWithdrawals[msg.sender] = 0;
        (bool success, ) = payable(msg.sender).call{value: amount}("");
        require(success, "Transfer Failed: ETH transfer reverted");

        emit FundsWithdrawn(msg.sender, amount);
    }

    // -------------------------------------------------------------------------
    // View Functions
    // -------------------------------------------------------------------------

    /**
     * @notice Retrieves the complete on-chain record for a given shipment.
     * @param _id Target shipment identifier.
     * @return Shipment struct containing all terms, status, and telemetry.
     */
    function getShipment(uint256 _id) external view returns (Shipment memory) {
        require(_id > 0 && _id <= shipmentCounter, "Invalid Input: Shipment ID out of range");
        return shipments[_id];
    }
}
