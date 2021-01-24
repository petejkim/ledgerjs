//@flow
import AppEth from "@ledgerhq/hw-app-eth";
import type Transport from "@ledgerhq/hw-transport";
import HookedWalletSubprovider from "web3-provider-engine/subproviders/hooked-wallet";
import { Transaction } from "cipher-ethereum";
import BN from "bn.js";
import * as rlp from 'rlp'

function makeError(msg, id) {
  const err = new Error(msg);
  // $FlowFixMe
  err.id = id;
  return err;
}

/**
 */
type SubproviderOptions = {
  // refer to https://github.com/ethereum/EIPs/blob/master/EIPS/eip-155.md
  networkId: number,
  // derivation path schemes (with a x in the path)
  paths?: string[],
  // should use actively validate on the device
  askConfirm?: boolean,
  // number of accounts to derivate
  accountsLength?: number,
  // offset index to use to start derivating the accounts
  accountsOffset?: number,
};

const defaultOptions = {
  networkId: 1, // mainnet
  paths: ["44'/60'/x'/0/0", "44'/60'/0'/x"], // ledger live derivation path
  askConfirm: false,
  accountsLength: 1,
  accountsOffset: 0,
};

/**
 * Create a HookedWalletSubprovider for Ledger devices.
 * @param getTransport gets lazily called each time the device is needed. It is a function that returns a Transport instance. You can typically give `()=>TransportU2F.create()`
 * @example
import Web3 from "web3";
import createLedgerSubprovider from "@ledgerhq/web3-subprovider";
import TransportU2F from "@ledgerhq/hw-transport-u2f";
import ProviderEngine from "web3-provider-engine";
import RpcSubprovider from "web3-provider-engine/subproviders/rpc";
const engine = new ProviderEngine();
const getTransport = () => TransportU2F.create();
const ledger = createLedgerSubprovider(getTransport, {
  accountsLength: 5
});
engine.addProvider(ledger);
engine.addProvider(new RpcSubprovider({ rpcUrl }));
engine.start();
const web3 = new Web3(engine);
 */
export default function createLedgerSubprovider(
  getTransport: () => Transport<*>,
  options?: SubproviderOptions
): HookedWalletSubprovider {
  if (options && "path" in options) {
    throw new Error(
      "@ledgerhq/web3-subprovider: path options was replaced by paths. example: paths: [\"44'/60'/x'/0/0\"]"
    );
  }
  const { networkId, paths, askConfirm, accountsLength, accountsOffset } = {
    ...defaultOptions,
    ...options,
  };

  if (!paths.length) {
    throw new Error("paths must not be empty");
  }

  const addressToPathMap = {};

  async function getAccounts() {
    const transport = await getTransport();
    try {
      const eth = new AppEth(transport);
      const addresses = {};
      for (let i = accountsOffset; i < accountsOffset + accountsLength; i++) {
        const x = Math.floor(i / paths.length);
        const pathIndex = i - paths.length * x;
        const path = paths[pathIndex].replace("x", String(x));
        const address = await eth.getAddress(path, askConfirm, false);
        addresses[path] = address.address;
        addressToPathMap[address.address.toLowerCase()] = path;
      }
      return addresses;
    } finally {
      transport.close();
    }
  }

  async function signPersonalMessage(msgData) {
    const path = addressToPathMap[msgData.from.toLowerCase()];
    if (!path) throw new Error("address unknown '" + msgData.from + "'");
    const transport = await getTransport();
    try {
      const eth = new AppEth(transport);
      const result = await eth.signPersonalMessage(
        path,
        strip0x(msgData.data)
      );
      const v = parseInt(result.v, 10) - 27;
      let vHex = v.toString(16);
      if (vHex.length < 2) {
        vHex = `0${v}`;
      }
      return `0x${result.r}${result.s}${vHex}`;
    } finally {
      transport.close();
    }
  }

  async function signTransaction(txData) {
    const path = addressToPathMap[txData.from.toLowerCase()];
    if (!path) throw new Error("address unknown '" + txData.from + "'");
    const transport = await getTransport();
    try {
      const eth = new AppEth(transport);

      const tx = new Transaction({
        toAddress: txData.to || null,
        valueWei: hexToBN(txData.value) || new BN(0),
        gasPriceWei: hexToBN(txData.gasPrice) || new BN(0),
        gasLimit: hexToBN(txData.gas) || new BN(21000),
        data: txData.data || null,
        nonce: Number.parseInt(txData.nonce, 16) || 0,
        chainId: networkId
      });

      // Pass hex-rlp to ledger for signing
      const result = await eth.signTransaction(
        path,
        rlp.encode(tx.fieldsForSigning).toString("hex")
      );

      // Store signature in transaction
      tx.v = Number.parseInt(result.v, 16);
      tx.r = Buffer.from(result.r, "hex");
      tx.s = Buffer.from(result.s, "hex");

      // EIP155: v should be chain_id * 2 + {35, 36}
      const signedChainId = Math.floor((tx.v - 35) / 2);
      if (signedChainId !== networkId) {
        throw makeError(
          "Invalid networkId signature returned. Expected: " +
            networkId +
            ", Got: " +
            signedChainId,
          "InvalidNetworkId"
        );
      }

      return `0x${tx.rlp.toString("hex")}`;
    } finally {
      transport.close();
    }
  }

  const subprovider = new HookedWalletSubprovider({
    getAccounts: (callback) => {
      getAccounts()
        .then((res) => callback(null, Object.values(res)))
        .catch((err) => callback(err, null));
    },
    signPersonalMessage: (txData, callback) => {
      signPersonalMessage(txData)
        .then((res) => callback(null, res))
        .catch((err) => callback(err, null));
    },
    signTransaction: (txData, callback) => {
      signTransaction(txData)
        .then((res) => callback(null, res))
        .catch((err) => callback(err, null));
    },
  });

  return subprovider;
}

function hexToBN(hex) {
  return hex ? new BN(strip0x(hex), 16) : null;
}

function strip0x(str) {
  if (typeof str !== "string") {
    throw new TypeError();
  }
  return str.startsWith("0x") ? str.slice(2) : str;
}
