// Ethers v6 helpers for the QROS quorum-attestation verifier.
// Run only in a trusted validator/operations environment. Never expose validator
// private keys in the browser, dApp bundle, logs, or repository.
const { ethers } = require('ethers');

const DELIVERY_TYPES = {
  Delivery: [
    { name: 'transferId', type: 'bytes32' },
    { name: 'sourceChainId', type: 'uint256' },
    { name: 'destinationChainId', type: 'uint256' },
    { name: 'recipient', type: 'address' },
    { name: 'destinationAsset', type: 'address' },
    { name: 'amount', type: 'uint256' },
    { name: 'deadline', type: 'uint256' }
  ]
};
const RECOVERY_TYPES = {
  Recovery: [
    { name: 'transferId', type: 'bytes32' },
    { name: 'sourceChainId', type: 'uint256' },
    { name: 'sourceAsset', type: 'address' },
    { name: 'amount', type: 'uint256' },
    { name: 'deadline', type: 'uint256' }
  ]
};
const OUTBOUND_SETTLED_TYPES = {
  OutboundSettled: [
    { name: 'transferId', type: 'bytes32' },
    { name: 'sourceChainId', type: 'uint256' },
    { name: 'destinationChainId', type: 'uint256' },
    { name: 'sourceAsset', type: 'address' },
    { name: 'amount', type: 'uint256' },
    { name: 'deadline', type: 'uint256' }
  ]
};
const CANCELLATION_TYPES = {
  Cancellation: [
    { name: 'transferId', type: 'bytes32' },
    { name: 'sourceChainId', type: 'uint256' },
    { name: 'deadline', type: 'uint256' }
  ]
};

const domain = (chainId, verifyingContract) => ({
  name: 'QROS Quorum Settlement Attestation',
  version: '1',
  chainId: BigInt(chainId),
  verifyingContract: ethers.getAddress(verifyingContract)
});

async function signatures(wallets, domainData, types, value) {
  const signed = await Promise.all(wallets.map(async wallet => ({
    address: ethers.getAddress(await wallet.getAddress()),
    signature: await wallet.signTypedData(domainData, types, value)
  })));
  signed.sort((a, b) => a.address.toLowerCase().localeCompare(b.address.toLowerCase()));
  for (let i = 1; i < signed.length; i++) {
    if (signed[i - 1].address.toLowerCase() === signed[i].address.toLowerCase()) {
      throw new Error('Duplicate validator signer');
    }
  }
  return signed.map(x => x.signature);
}

async function deliveryProof({ wallets, verifier, transferId, sourceChainId, destinationChainId, recipient, destinationAsset, amount, deadline }) {
  const value = {
    transferId, sourceChainId: BigInt(sourceChainId), destinationChainId: BigInt(destinationChainId),
    recipient: ethers.getAddress(recipient), destinationAsset: ethers.getAddress(destinationAsset),
    amount: BigInt(amount), deadline: BigInt(deadline)
  };
  const sigs = await signatures(wallets, domain(destinationChainId, verifier), DELIVERY_TYPES, value);
  return ethers.AbiCoder.defaultAbiCoder().encode(
    ['uint256','uint256','address','address','uint256','uint256','bytes[]'],
    [value.sourceChainId,value.destinationChainId,value.recipient,value.destinationAsset,value.amount,value.deadline,sigs]
  );
}

async function recoveryProof({ wallets, verifier, transferId, sourceChainId, sourceAsset, amount, deadline }) {
  const value = {
    transferId, sourceChainId: BigInt(sourceChainId), sourceAsset: ethers.getAddress(sourceAsset),
    amount: BigInt(amount), deadline: BigInt(deadline)
  };
  const sigs = await signatures(wallets, domain(sourceChainId, verifier), RECOVERY_TYPES, value);
  return ethers.AbiCoder.defaultAbiCoder().encode(
    ['uint256','address','uint256','uint256','bytes[]'],
    [value.sourceChainId,value.sourceAsset,value.amount,value.deadline,sigs]
  );
}

async function cancellationProof({ wallets, verifier, transferId, sourceChainId, deadline }) {
  const value = { transferId, sourceChainId: BigInt(sourceChainId), deadline: BigInt(deadline) };
  const sigs = await signatures(wallets, domain(sourceChainId, verifier), CANCELLATION_TYPES, value);
  return ethers.AbiCoder.defaultAbiCoder().encode(
    ['uint256','uint256','bytes[]'], [value.sourceChainId,value.deadline,sigs]
  );
}

async function outboundSettlementProof({ wallets, verifier, transferId, sourceChainId, destinationChainId, sourceAsset, amount, deadline }) {
  const value = {
    transferId, sourceChainId: BigInt(sourceChainId), destinationChainId: BigInt(destinationChainId),
    sourceAsset: ethers.getAddress(sourceAsset), amount: BigInt(amount), deadline: BigInt(deadline)
  };
  const sigs = await signatures(wallets, domain(sourceChainId, verifier), OUTBOUND_SETTLED_TYPES, value);
  return ethers.AbiCoder.defaultAbiCoder().encode(
    ['uint256','uint256','address','uint256','uint256','bytes[]'],
    [value.sourceChainId,value.destinationChainId,value.sourceAsset,value.amount,value.deadline,sigs]
  );
}

module.exports = { deliveryProof, recoveryProof, cancellationProof, outboundSettlementProof };
