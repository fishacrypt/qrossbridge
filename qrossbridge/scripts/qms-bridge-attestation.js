// Ethers v6 signing helpers for QMS Hub/Spoke Gateway settlement attestations.
// Validator keys must stay in an isolated validator service, never in browser code.
const { ethers } = require('ethers');

const TYPES = { QmsBridgeDelivery: [
  { name: 'transferId', type: 'bytes32' },
  { name: 'sourceChainId', type: 'uint256' },
  { name: 'destinationChainId', type: 'uint256' },
  { name: 'sourceBridge', type: 'address' },
  { name: 'destinationBridge', type: 'address' },
  { name: 'sourceAdapter', type: 'address' },
  { name: 'destinationAdapter', type: 'address' },
  { name: 'sourceToken', type: 'address' },
  { name: 'destinationToken', type: 'address' },
  { name: 'beneficiary', type: 'address' },
  { name: 'amount', type: 'uint256' },
  { name: 'bridgeMessageId', type: 'bytes32' },
  { name: 'deadline', type: 'uint256' }
]};
const domain = (chainId, verifier) => ({
  name: 'QROS QMS Bridge Attestation', version: '1',
  chainId: BigInt(chainId), verifyingContract: ethers.getAddress(verifier)
});
async function qmsBridgeDeliveryProof({
  wallets, verifier, transferId, sourceChainId, destinationChainId,
  sourceBridge, destinationBridge, sourceAdapter, destinationAdapter, sourceToken, destinationToken,
  beneficiary, amount, bridgeMessageId, deadline
}) {
  const value = {
    transferId, sourceChainId: BigInt(sourceChainId), destinationChainId: BigInt(destinationChainId),
    sourceBridge: ethers.getAddress(sourceBridge), destinationBridge: ethers.getAddress(destinationBridge),
    sourceAdapter: ethers.getAddress(sourceAdapter), destinationAdapter: ethers.getAddress(destinationAdapter),
    sourceToken: ethers.getAddress(sourceToken), destinationToken: ethers.getAddress(destinationToken), beneficiary: ethers.getAddress(beneficiary),
    amount: BigInt(amount), bridgeMessageId, deadline: BigInt(deadline)
  };
  const signed = await Promise.all(wallets.map(async wallet => ({
    address: ethers.getAddress(await wallet.getAddress()),
    signature: await wallet.signTypedData(domain(destinationChainId, verifier), TYPES, value)
  })));
  signed.sort((a,b)=>a.address.toLowerCase().localeCompare(b.address.toLowerCase()));
  for(let i=1;i<signed.length;i++) {
    if(signed[i-1].address.toLowerCase()===signed[i].address.toLowerCase()) throw new Error('Duplicate QMS validator signer');
  }
  return ethers.AbiCoder.defaultAbiCoder().encode(
    ['uint256','uint256','address','address','address','address','address','address','address','uint256','bytes32','uint256','bytes[]'],
    [value.sourceChainId,value.destinationChainId,value.sourceBridge,value.destinationBridge,
     value.sourceAdapter,value.destinationAdapter,value.sourceToken,value.destinationToken,value.beneficiary,
     value.amount,value.bridgeMessageId,value.deadline,signed.map(x=>x.signature)]
  );
}
function combineSettlementAndBridgeProof(settlementProof, bridgeProof) {
  return ethers.AbiCoder.defaultAbiCoder().encode(['bytes','bytes'],[settlementProof,bridgeProof]);
}
module.exports = { qmsBridgeDeliveryProof, combineSettlementAndBridgeProof };
