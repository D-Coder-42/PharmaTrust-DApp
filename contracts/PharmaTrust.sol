// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title PharmaTrust
 * @dev Autonomous cold-chain SLA escrow with IoT telemetry, GPS checkpoint logging, and delay penalties.
 */
contract PharmaTrust {
    address public immutable platformOwner;
    uint256 public shipmentCounter;

    // 5-stage state machine (Module 4, Slide 89)
    enum ShipmentStatus { Created, InTransit, Delivered, Breached, Settled }

    // Composite structure tracking shipment telemetry & SLA terms (Module 4, Slide 90)
    struct Shipment {
        uint256 id;
        string cargoDescription;
        string destination;
        string lastRecordedLocation;
        address payable shipper;
        address payable carrier;
        address iotSensorAddress;   // Inbound hardware oracle public address
        int256 minSafeTemp;         // Signed integer for sub-zero thresholds in °C (Slide 76)
        int256 maxSafeTemp;
        uint256 shippingFee;        // Escrow funded by shipper (in Wei)
        uint256 carrierCollateral;  // Performance bond staked by carrier (in Wei)
        uint256 deliveryDeadline;   // Unix timestamp deadline
        uint256 latePenalty;        // Penalty deducted if delivered past deadline
        int256 lastRecordedTemp;
        uint256 lastPingTimestamp;
        ShipmentStatus status;
    }

    // Mappings for record lookup and pull-payment vault (Module 4, Slide 86)
    mapping(uint256 => Shipment) public shipments;
    mapping(address => uint256) public pendingWithdrawals;

    // Events for frontend & block explorer monitoring (Module 4, Slide 96)
    event ShipmentCreated(uint256 indexed id, string cargo, string destination, uint256 deadline, uint256 fee);
    event CustodyAccepted(uint256 indexed id, address indexed carrier, uint256 collateralStaked);
    event TelemetryLogged(uint256 indexed id, int256 currentTemp, string location, uint256 timestamp);
    event SLABreached(uint256 indexed id, int256 breachTemp, uint256 collateralSlashed);
    event ShipmentDelivered(uint256 indexed id, uint256 carrierPayout, uint256 delayPenaltyDeducted);
    event FundsWithdrawn(address indexed user, uint256 amount);

    // Modifiers for role-based access control and state validation (Module 4, Slide 94)
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

    constructor() {
        platformOwner = msg.sender;
    }

    /**
     * @notice 1. Shipper initializes cargo record, sets SLA parameters, and funds shipping escrow
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
     * @notice 2. Carrier accepts physical custody and stakes the required performance bond
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
     * @notice 3. Inbound hardware oracle streams temperature and GPS checkpoint data
     * @dev Automatically slashes carrier bond and refunds shipper on temperature excursion
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

        // Autonomous SLA enforcement check (Module 4, Slides 6, 8, 36)
        if (_currentTemp < s.minSafeTemp || _currentTemp > s.maxSafeTemp) {
            s.status = ShipmentStatus.Breached;
            uint256 totalRefundAndPenalty = s.shippingFee + s.carrierCollateral;

            // Route all vaulted funds to shipper's pull-vault
            pendingWithdrawals[s.shipper] += totalRefundAndPenalty;
            emit SLABreached(_id, _currentTemp, s.carrierCollateral);
        }
    }

    /**
     * @notice 4. Shipper confirms delivery: deducts delay penalty if late and routes net payout
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

        // Delay penalty enforcement
        if (block.timestamp > s.deliveryDeadline) {
            penaltyDeducted = s.latePenalty;
            carrierPayout -= penaltyDeducted;
            pendingWithdrawals[s.shipper] += penaltyDeducted;
        }

        // Net payout routed to carrier pull-vault
        pendingWithdrawals[s.carrier] += carrierPayout;

        emit ShipmentDelivered(_id, carrierPayout, penaltyDeducted);
    }

    /**
     * @notice 5. Pull-pattern fund transfer to guard against reentrancy
     */
    function withdrawVault() external {
        uint256 amount = pendingWithdrawals[msg.sender];
        require(amount > 0, "Invalid Request: No withdrawable funds");

        pendingWithdrawals[msg.sender] = 0;
        (bool success, ) = payable(msg.sender).call{value: amount}("");
        require(success, "Transfer Failed: ETH transfer reverted");

        emit FundsWithdrawn(msg.sender, amount);
    }

    /**
     * @notice View function for frontend UI data retrieval
     */
    function getShipment(uint256 _id) external view returns (Shipment memory) {
        require(_id > 0 && _id <= shipmentCounter, "Invalid Input: Shipment ID out of range");
        return shipments[_id];
    }
}
