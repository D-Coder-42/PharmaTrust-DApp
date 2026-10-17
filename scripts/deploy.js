const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const [deployer] = await ethers.getSigners();
  const net = await ethers.provider.getNetwork();

  console.log("====================================================");
  console.log(" PharmaTrust Protocol Deployment Pipeline");
  console.log("====================================================");
  console.log(`Target Network:   ${network.name} (Chain ID: ${net.chainId})`);
  console.log(`Deployer Account: ${deployer.address}`);

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log(`Deployer Balance: ${ethers.formatEther(balance)} ETH`);

  console.log("\nBroadcasting contract deployment transaction...");
  const PharmaTrust = await ethers.getContractFactory("PharmaTrust");
  const pharmaTrust = await PharmaTrust.deploy();
  await pharmaTrust.waitForDeployment();

  const contractAddress = await pharmaTrust.getAddress();
  const txHash = pharmaTrust.deploymentTransaction().hash;

  console.log(`Contract Deployed Successfully!`);
  console.log(`Address:          ${contractAddress}`);
  console.log(`Transaction Hash: ${txHash}`);

  // Automatically synchronize deployment metadata with frontend
  const configPath = path.join(__dirname, "..", "frontend", "contract-config.json");
  const deploymentMetadata = {
    address: contractAddress,
    chainId: Number(net.chainId),
    network: network.name,
    deployer: deployer.address,
    transactionHash: txHash,
    deployedAt: new Date().toISOString()
  };

  fs.writeFileSync(configPath, JSON.stringify(deploymentMetadata, null, 2));
  console.log(`\nUpdated frontend deployment config: ${configPath}`);
  console.log("====================================================");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("FATAL: Deployment pipeline failed:", error);
    process.exit(1);
  });
