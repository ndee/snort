import * as utils from "@noble/curves/abstract/utils";
import * as secp from "@noble/curves/secp256k1";
import { unixNowMs } from "@snort/shared";
import {
  EventPublisher,
  KeyStorage,
  Nip7Signer,
  Nip46Signer,
  PrivateKeySigner,
  RelaySettings,
  SystemInterface,
  UserMetadata,
} from "@snort/system";

import { GiftsCache } from "@/Cache";
import SnortApi from "@/External/SnortApi";
import { bech32ToHex, dedupeById, deleteRefCode, getCountry, sanitizeRelayUrl, unwrap } from "@/Utils";
import { Blasters } from "@/Utils/Const";
import { LoginSession, LoginSessionType, LoginStore, SnortAppData } from "@/Utils/Login/index";
import { entropyToPrivateKey, generateBip39Entropy } from "@/Utils/nip6";
import { SubscriptionEvent } from "@/Utils/Subscription";

import { Nip7OsSigner } from "./Nip7OsSigner";

export function setRelays(state: LoginSession, relays: Record<string, RelaySettings>, createdAt: number) {
  if (import.meta.env.VITE_SINGLE_RELAY) {
    state.relays.item = {
      [import.meta.env.VITE_SINGLE_RELAY]: { read: true, write: true },
    };
    state.relays.timestamp = 100;
    LoginStore.updateSession(state);
    return;
  }

  if (state.relays.timestamp >= createdAt) {
    return;
  }

  // filter out non-websocket urls
  const filtered = new Map<string, RelaySettings>();
  for (const [k, v] of Object.entries(relays)) {
    if (k.startsWith("wss://") || k.startsWith("ws://")) {
      const url = sanitizeRelayUrl(k);
      if (url) {
        filtered.set(url, v as RelaySettings);
      }
    }
  }
  state.relays.item = Object.fromEntries(filtered.entries());
  state.relays.timestamp = createdAt;
  LoginStore.updateSession(state);
}

export function removeRelay(state: LoginSession, addr: string) {
  delete state.relays.item[addr];
  LoginStore.updateSession(state);
}

export function logout(id: string) {
  LoginStore.removeSession(id);
  GiftsCache.clear();
  deleteRefCode();
  localStorage.clear();
}

export function markNotificationsRead(state: LoginSession) {
  state.readNotifications = unixNowMs();
  LoginStore.updateSession(state);
}

export function clearEntropy(state: LoginSession) {
  state.generatedEntropy = undefined;
  LoginStore.updateSession(state);
}

/**
 * Generate a new key and login with this generated key
 */
export async function generateNewLogin(
  system: SystemInterface,
  pin: (key: string) => Promise<KeyStorage>,
  profile: UserMetadata,
) {
  const ent = generateBip39Entropy();
  const entropy = utils.bytesToHex(ent);
  const privateKey = entropyToPrivateKey(ent);
  const newRelays = {} as Record<string, RelaySettings>;

  // Use current timezone info to determine approx location
  // use closest 5 relays
  const country = getCountry();
  const api = new SnortApi();
  const closeRelays = await api.closeRelays(country.lat, country.lon, 20);
  for (const cr of closeRelays.sort((a, b) => (a.distance > b.distance ? 1 : -1)).filter(a => !a.is_paid)) {
    const rr = sanitizeRelayUrl(cr.url);
    if (rr) {
      newRelays[rr] = { read: true, write: true };
      if (Object.keys(newRelays).length >= 5) {
        break;
      }
    }
  }
  for (const [k, v] of Object.entries(CONFIG.defaultRelays)) {
    if (!newRelays[k]) {
      newRelays[k] = v;
    }
  }

  // connect to new relays
  await Promise.all(Object.entries(newRelays).map(([k, v]) => system.ConnectToRelay(k, v)));

  const publicKey = utils.bytesToHex(secp.schnorr.getPublicKey(privateKey));
  const publisher = EventPublisher.privateKey(privateKey);

  // Create new contact list following self and site account
  const contactList = [publicKey, ...CONFIG.signUp.defaultFollows.map(a => bech32ToHex(a))].map(a => ["p", a]) as Array<
    [string, string]
  >;
  const ev = await publisher.contactList(contactList, newRelays);
  system.BroadcastEvent(ev);

  // Create relay metadata event
  const ev2 = await publisher.relayList(newRelays);
  system.BroadcastEvent(ev2);
  Promise.all(Blasters.map(a => system.WriteOnceToRelay(a, ev2)));

  // Publish new profile
  const ev3 = await publisher.metadata(profile);
  system.BroadcastEvent(ev3);
  Promise.all(Blasters.map(a => system.WriteOnceToRelay(a, ev3)));

  LoginStore.loginWithPrivateKey(await pin(privateKey), entropy, newRelays);
}

export function generateRandomKey() {
  const privateKey = utils.bytesToHex(secp.schnorr.utils.randomPrivateKey());
  const publicKey = utils.bytesToHex(secp.schnorr.getPublicKey(privateKey));
  return {
    privateKey,
    publicKey,
  };
}

export function setTags(state: LoginSession, tags: Array<string>, ts: number) {
  if (state.tags.timestamp >= ts) {
    return;
  }
  state.tags.item = tags;
  state.tags.timestamp = ts;
  LoginStore.updateSession(state);
}

export function setMuted(state: LoginSession, muted: Array<string>, ts: number) {
  if (state.muted.timestamp >= ts) {
    return;
  }
  state.muted.item = muted;
  state.muted.timestamp = ts;
  LoginStore.updateSession(state);
}

export function setBlocked(state: LoginSession, blocked: Array<string>, ts: number) {
  if (state.blocked.timestamp >= ts) {
    return;
  }
  state.blocked.item = blocked;
  state.blocked.timestamp = ts;
  LoginStore.updateSession(state);
}

export function updateSession(id: string, fn: (state: LoginSession) => void) {
  const session = LoginStore.get(id);
  if (session) {
    fn(session);
    LoginStore.updateSession(session);
  }
}

export function setPinned(state: LoginSession, pinned: Array<string>, ts: number) {
  if (state.pinned.timestamp >= ts) {
    return;
  }
  state.pinned.item = pinned;
  state.pinned.timestamp = ts;
  LoginStore.updateSession(state);
}

export function setBookmarked(state: LoginSession, bookmarked: Array<string>, ts: number) {
  if (state.bookmarked.timestamp >= ts) {
    return;
  }
  state.bookmarked.item = bookmarked;
  state.bookmarked.timestamp = ts;
  LoginStore.updateSession(state);
}

export async function setAppData(state: LoginSession, data: SnortAppData, system: SystemInterface) {
  const pub = LoginStore.getPublisher(state.id);
  if (!pub) return;

  await state.appData.updateJson(data, pub.signer, system);
  LoginStore.updateSession(state);
}

export async function updateAppData(id: string, system: SystemInterface, fn: (data: SnortAppData) => SnortAppData) {
  const session = LoginStore.get(id);
  if (session) {
    const next = fn(session.appData.json);
    await setAppData(session, next, system);
  }
}

export function addSubscription(state: LoginSession, ...subs: SubscriptionEvent[]) {
  const newSubs = dedupeById([...(state.subscriptions || []), ...subs]);
  if (newSubs.length !== state.subscriptions.length) {
    state.subscriptions = newSubs;
    LoginStore.updateSession(state);
  }
}

export function sessionNeedsPin(l: LoginSession) {
  return l.privateKeyData && l.privateKeyData.shouldUnlock();
}

export function createPublisher(l: LoginSession) {
  switch (l.type) {
    case LoginSessionType.PrivateKey: {
      return EventPublisher.privateKey(unwrap(l.privateKeyData as KeyStorage).value);
    }
    case LoginSessionType.Nip46: {
      const relayArgs = (l.remoteSignerRelays ?? []).map(a => `relay=${encodeURIComponent(a)}`);
      const inner = new PrivateKeySigner(unwrap(l.privateKeyData as KeyStorage).value);
      const nip46 = new Nip46Signer(`bunker://${unwrap(l.publicKey)}?${[...relayArgs].join("&")}`, inner);
      nip46.on("oauth", url => {
        window.open(url, CONFIG.appNameCapitalized, "width=600,height=800,popup=yes");
      });
      return new EventPublisher(nip46, unwrap(l.publicKey));
    }
    case LoginSessionType.Nip7os: {
      return new EventPublisher(new Nip7OsSigner(), unwrap(l.publicKey));
    }
    case LoginSessionType.Nip7: {
      return new EventPublisher(new Nip7Signer(), unwrap(l.publicKey));
    }
  }
}
