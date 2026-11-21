// This device's passkey through the Windows WebAuthn API (webauthn.dll), so signing in is one Windows Hello
// prompt from the app itself. A browser would only allow passkeys for its page's own domain; a native app
// builds the client data itself, naming the server's origin, and the server checks it (docs/passkeys.md).
// Byte fields cross to JavaScript as base64url strings.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64, Engine};
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateOptions {
  rp_id: String,
  rp_name: String,
  user_id: String,
  user_name: String,
  challenge: String,
  timeout_ms: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Created {
  credential_id: String,
  #[serde(rename = "clientDataJSON")]
  client_data_json: String,
  attestation_object: String,
  transports: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetOptions {
  rp_id: String,
  challenge: String,
  allow_credentials: Vec<String>,
  timeout_ms: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Assertion {
  credential_id: String,
  #[serde(rename = "clientDataJSON")]
  client_data_json: String,
  authenticator_data: String,
  signature: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  user_handle: Option<String>,
}

fn client_data(kind: &str, challenge: &str, origin: &str) -> Vec<u8> {
  serde_json::json!({ "type": kind, "challenge": challenge, "origin": origin, "crossOrigin": false })
    .to_string()
    .into_bytes()
}

fn decode(field: &str, value: &str) -> Result<Vec<u8>, String> {
  B64.decode(value).map_err(|_| format!("The server sent a malformed {field}."))
}

/// Runs the blocking Windows call off the main thread, parented to the app window so the prompt sits on top.
async fn blocking<T: Send + 'static>(
  window: tauri::WebviewWindow,
  f: impl FnOnce(isize) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
  #[cfg(windows)]
  let hwnd = window.hwnd().map_err(|e| e.to_string())?.0 as isize;
  #[cfg(not(windows))]
  let hwnd = {
    let _ = window;
    0
  };
  tauri::async_runtime::spawn_blocking(move || f(hwnd)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn passkey_create(window: tauri::WebviewWindow, options: CreateOptions, origin: String) -> Result<Created, String> {
  let user_id = decode("user id", &options.user_id)?;
  decode("challenge", &options.challenge)?;
  let data = client_data("webauthn.create", &options.challenge, &origin);
  blocking(window, move |hwnd| imp::create(hwnd, &options, &user_id, data)).await
}

#[tauri::command]
pub async fn passkey_get(window: tauri::WebviewWindow, options: GetOptions, origin: String) -> Result<Assertion, String> {
  let ids = options
    .allow_credentials
    .iter()
    .map(|id| decode("credential id", id))
    .collect::<Result<Vec<_>, _>>()?;
  decode("challenge", &options.challenge)?;
  let data = client_data("webauthn.get", &options.challenge, &origin);
  blocking(window, move |hwnd| imp::get(hwnd, &options, ids, data)).await
}

#[cfg(windows)]
mod imp {
  use super::*;
  use windows::core::{HSTRING, PCWSTR};
  use windows::Win32::Foundation::HWND;
  use windows::Win32::Networking::WindowsWebServices::*;

  /// Options structs at version 4 are understood by every Windows 10/11 release with passkeys.
  const OPTIONS_VERSION: u32 = 4;

  fn bytes(ptr: *const u8, len: u32) -> Vec<u8> {
    if ptr.is_null() || len == 0 {
      return Vec::new();
    }
    unsafe { std::slice::from_raw_parts(ptr, len as usize) }.to_vec()
  }

  fn failure(e: windows::core::Error) -> String {
    // NTE_USER_CANCELLED and similar: the person closed the prompt or it timed out.
    let cancelled = matches!(e.code().0 as u32, 0x8009_0036 | 0x8007_04C7 | 0x8000_4004);
    if cancelled {
      "The Windows Hello prompt was cancelled.".into()
    } else {
      format!("Windows Hello couldn't complete the request ({}).", e.message())
    }
  }

  fn hash_alg_and_data(data: &mut [u8]) -> WEBAUTHN_CLIENT_DATA {
    WEBAUTHN_CLIENT_DATA {
      dwVersion: WEBAUTHN_CLIENT_DATA_CURRENT_VERSION,
      cbClientDataJSON: data.len() as u32,
      pbClientDataJSON: data.as_mut_ptr(),
      pwszHashAlgId: WEBAUTHN_HASH_ALGORITHM_SHA_256,
    }
  }

  pub fn create(hwnd: isize, o: &CreateOptions, user_id: &[u8], mut data: Vec<u8>) -> Result<Created, String> {
    let rp_id = HSTRING::from(o.rp_id.as_str());
    let rp_name = HSTRING::from(o.rp_name.as_str());
    let user_name = HSTRING::from(o.user_name.as_str());
    let mut user_id = user_id.to_vec();
    let rp = WEBAUTHN_RP_ENTITY_INFORMATION {
      dwVersion: WEBAUTHN_RP_ENTITY_INFORMATION_CURRENT_VERSION,
      pwszId: PCWSTR(rp_id.as_ptr()),
      pwszName: PCWSTR(rp_name.as_ptr()),
      pwszIcon: PCWSTR::null(),
    };
    let user = WEBAUTHN_USER_ENTITY_INFORMATION {
      dwVersion: WEBAUTHN_USER_ENTITY_INFORMATION_CURRENT_VERSION,
      cbId: user_id.len() as u32,
      pbId: user_id.as_mut_ptr(),
      pwszName: PCWSTR(user_name.as_ptr()),
      pwszIcon: PCWSTR::null(),
      pwszDisplayName: PCWSTR(user_name.as_ptr()),
    };
    let mut param = WEBAUTHN_COSE_CREDENTIAL_PARAMETER {
      dwVersion: WEBAUTHN_COSE_CREDENTIAL_PARAMETER_CURRENT_VERSION,
      pwszCredentialType: WEBAUTHN_CREDENTIAL_TYPE_PUBLIC_KEY,
      lAlg: WEBAUTHN_COSE_ALGORITHM_ECDSA_P256_WITH_SHA256,
    };
    let params = WEBAUTHN_COSE_CREDENTIAL_PARAMETERS { cCredentialParameters: 1, pCredentialParameters: &mut param };
    let client = hash_alg_and_data(&mut data);
    let options = WEBAUTHN_AUTHENTICATOR_MAKE_CREDENTIAL_OPTIONS {
      dwVersion: OPTIONS_VERSION,
      dwTimeoutMilliseconds: o.timeout_ms,
      // No attachment preference: some Windows builds reject PLATFORM as an invalid parameter. Windows offers
      // Windows Hello first; the server refuses any passkey that could be synced off this device.
      dwAuthenticatorAttachment: WEBAUTHN_AUTHENTICATOR_ATTACHMENT_ANY,
      dwUserVerificationRequirement: WEBAUTHN_USER_VERIFICATION_REQUIREMENT_REQUIRED,
      dwAttestationConveyancePreference: WEBAUTHN_ATTESTATION_CONVEYANCE_PREFERENCE_NONE,
      ..Default::default()
    };
    unsafe {
      let att = WebAuthNAuthenticatorMakeCredential(HWND(hwnd as _), &rp, &user, &params, &client, Some(&options))
        .map_err(failure)?;
      let a = &*att;
      let created = Created {
        credential_id: B64.encode(bytes(a.pbCredentialId, a.cbCredentialId)),
        client_data_json: B64.encode(&data),
        attestation_object: B64.encode(bytes(a.pbAttestationObject, a.cbAttestationObject)),
        transports: vec!["internal".into()],
      };
      WebAuthNFreeCredentialAttestation(Some(att));
      Ok(created)
    }
  }

  pub fn get(hwnd: isize, o: &GetOptions, mut ids: Vec<Vec<u8>>, mut data: Vec<u8>) -> Result<Assertion, String> {
    let rp_id = HSTRING::from(o.rp_id.as_str());
    let mut creds: Vec<WEBAUTHN_CREDENTIAL> = ids
      .iter_mut()
      .map(|id| WEBAUTHN_CREDENTIAL {
        dwVersion: WEBAUTHN_CREDENTIAL_CURRENT_VERSION,
        cbId: id.len() as u32,
        pbId: id.as_mut_ptr(),
        pwszCredentialType: WEBAUTHN_CREDENTIAL_TYPE_PUBLIC_KEY,
      })
      .collect();
    let client = hash_alg_and_data(&mut data);
    let options = WEBAUTHN_AUTHENTICATOR_GET_ASSERTION_OPTIONS {
      dwVersion: OPTIONS_VERSION,
      dwTimeoutMilliseconds: o.timeout_ms,
      // Only this device's passkey is allowed, so no attachment preference is needed (see create).
      CredentialList: WEBAUTHN_CREDENTIALS { cCredentials: creds.len() as u32, pCredentials: creds.as_mut_ptr() },
      dwAuthenticatorAttachment: WEBAUTHN_AUTHENTICATOR_ATTACHMENT_ANY,
      dwUserVerificationRequirement: WEBAUTHN_USER_VERIFICATION_REQUIREMENT_REQUIRED,
      ..Default::default()
    };
    unsafe {
      let ptr = WebAuthNAuthenticatorGetAssertion(HWND(hwnd as _), PCWSTR(rp_id.as_ptr()), &client, Some(&options))
        .map_err(failure)?;
      let a = &*ptr;
      let user = bytes(a.pbUserId, a.cbUserId);
      let assertion = Assertion {
        credential_id: B64.encode(bytes(a.Credential.pbId, a.Credential.cbId)),
        client_data_json: B64.encode(&data),
        authenticator_data: B64.encode(bytes(a.pbAuthenticatorData, a.cbAuthenticatorData)),
        signature: B64.encode(bytes(a.pbSignature, a.cbSignature)),
        user_handle: (!user.is_empty()).then(|| B64.encode(&user)),
      };
      WebAuthNFreeAssertion(ptr);
      Ok(assertion)
    }
  }
}

#[cfg(not(windows))]
mod imp {
  use super::*;

  pub fn create(_: isize, _: &CreateOptions, _: &[u8], _: Vec<u8>) -> Result<Created, String> {
    Err("Passkeys aren't supported on this platform yet.".into())
  }

  pub fn get(_: isize, _: &GetOptions, _: Vec<Vec<u8>>, _: Vec<u8>) -> Result<Assertion, String> {
    Err("Passkeys aren't supported on this platform yet.".into())
  }
}
