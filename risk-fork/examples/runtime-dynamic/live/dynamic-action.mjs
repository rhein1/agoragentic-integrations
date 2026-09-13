/* Real Dynamic SDK path. Never imported by the website or ordinary tests. */
import {setTimeout as delay} from 'node:timers/promises';
const RPC='https://sepolia.base.org';
const bounded=(promise,ms,code)=>{let timer;return Promise.race([promise,new Promise((_,r)=>{timer=setTimeout(()=>r(new Error(code)),ms);})]).finally(()=>clearTimeout(timer));};
export async function createDynamicAction(secret,{load=()=>Promise.all([import('@dynamic-labs-wallet/node-evm'),import('viem'),import('viem/chains')])}={}) {
  if(!secret||typeof secret.environment_id!=='string'||typeof secret.api_token!=='string'||!secret.account_address)throw new Error('invalid_secret_bundle');
  const [{DynamicEvmWalletClient},viem,{baseSepolia}]=await load();
  const client=new DynamicEvmWalletClient({environmentId:secret.environment_id});
  await bounded(client.authenticateApiToken(secret.api_token),15000,'dynamic_auth_timeout');
  const wallet=await bounded(client.getWalletClient({accountAddress:secret.account_address,
    externalServerKeyShares:secret.external_server_key_shares,password:secret.password,
    chain:baseSepolia,rpcUrl:RPC}),15000,'dynamic_client_timeout');
  const rpc=viem.createPublicClient({chain:baseSepolia,transport:viem.http(RPC,{retryCount:0,timeout:10000})});
  return async (approved)=>{
    if(approved.chainId!==84532||secret.account_address.toLowerCase()!==approved.from)throw new Error('account_or_chain_mismatch');
    if(await rpc.getChainId()!==84532)throw new Error('rpc_chain_mismatch');
    const code=await rpc.getBytecode({address:approved.to});
    if(code&&code!=='0x')throw new Error('demo_seller_must_be_eoa');
    const nonce=await rpc.getTransactionCount({address:approved.from,blockTag:'pending'});
    if(!Number.isSafeInteger(nonce)||nonce<0)throw new Error('invalid_nonce');
    const request={chain:baseSepolia,account:wallet.account,type:'eip1559',chainId:84532,
      to:approved.to,value:BigInt(approved.value),gas:BigInt(approved.gas),nonce,
      maxFeePerGas:BigInt(approved.maxFeePerGas),maxPriorityFeePerGas:BigInt(approved.maxPriorityFeePerGas),data:'0x'};
    // The injected authorization fence is called after RPC awaits and directly before signing.
    if(typeof approved.assertCurrent!=='function')throw new Error('final_fence_required');
    approved.assertCurrent();
    const raw=await bounded(wallet.signTransaction(request),20000,'signing_outcome_unknown');
    const parsed=viem.parseTransaction(raw),signer=(await viem.recoverTransactionAddress({serializedTransaction:raw})).toLowerCase();
    if(signer!==approved.from||parsed.chainId!==84532||parsed.to?.toLowerCase()!==approved.to||parsed.value!==BigInt(approved.value)||parsed.gas!==21000n||parsed.nonce!==nonce||parsed.maxFeePerGas!==BigInt(approved.maxFeePerGas)||parsed.maxPriorityFeePerGas!==BigInt(approved.maxPriorityFeePerGas)||(parsed.data&&parsed.data!=='0x'))throw new Error('signed_transaction_mismatch');
    // Do not leak the raw usable signature/transaction. No second signing or broadcast attempt.
    approved.assertCurrent();
    const hash=await bounded(rpc.sendRawTransaction({serializedTransaction:raw}),15000,'broadcast_outcome_unknown');
    const end=Date.now()+90000;let receipt=null;
    while(Date.now()<end){
      try {receipt=await rpc.getTransactionReceipt({hash});}catch {receipt=null;}
      if(receipt){const block=await rpc.getBlockNumber();if(block>=receipt.blockNumber+1n)break;receipt=null;}
      await delay(2000);
    }
    if(!receipt)return {status:'reconciliation_required',dynamic_contacted:true,signature:'verified',submission:'submitted',transaction_hash:hash,settlement:'unverified',automatic_retry:false};
    const tx=await rpc.getTransaction({hash});
    if(tx.from.toLowerCase()!==approved.from||tx.to?.toLowerCase()!==approved.to||tx.value!==BigInt(approved.value)||tx.nonce!==nonce||receipt.status!=='success')return {status:'reconciliation_required',dynamic_contacted:true,signature:'verified',submission:'submitted',transaction_hash:hash,settlement:'unverified',automatic_retry:false};
    return {status:'confirmed_testnet',dynamic_contacted:true,wallet_model:'dynamic_developer_owned_server_wallet',
      signature:'verified',submission:'submitted',transaction_hash:hash,network:'eip155:84532',
      value_wei:approved.value,confirmations_minimum:2,settlement:'observed_testnet_transfer',
      provider_policy_enforcement:'not_claimed',money_moved:false,testnet_tokens_moved:true,production_ready:false};
  };
}
