import log from "loglevel";

const defaults = {
    loglevel: "info" as log.LogLevelDesc,
    defaultLanguage: "en",
    telegramUrl: "https://t.me/+w0F2zxxoLg85YzM6",
    email: "swapmarket.wizard996@passinbox.com",
    repoUrl: "https://github.com/SwapMarket/usdt",
};

export type Config = {
    network?: "mainnet" | "testnet" | "regtest";
    blockExplorerUrl?: string;
    apiUrl?: string;
    dustBTC?: number;
    dustToken?: number;
} & typeof defaults;

let config: Config = defaults;

export const setConfig = (data: Config) => {
    config = { ...defaults, ...data };
    log.setLevel(config.loglevel);
};

export { config };
