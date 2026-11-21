package com.tdjr.notes;

import android.os.Build;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyPermanentlyInvalidatedException;
import android.security.keystore.KeyProperties;
import android.security.keystore.StrongBoxUnavailableException;
import android.util.Base64;

import androidx.annotation.NonNull;
import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.math.BigInteger;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.PrivateKey;
import java.security.Signature;
import java.security.interfaces.ECPublicKey;
import java.security.spec.ECGenParameterSpec;
import java.util.regex.Pattern;

/**
 * This tablet's device key (docs/mobile.md): a P-256 key in the Android Keystore (StrongBox when available) that
 * can't be exported, and signs only right after a fingerprint, face or screen-lock check. The web side frames
 * the key as a passkey (packages/core/src/nativeKey.ts). Values cross to JavaScript as base64url.
 */
@CapacitorPlugin(name = "DeviceKey")
public class DeviceKeyPlugin extends Plugin {
    private static final String KEYSTORE = "AndroidKeyStore";
    private static final String PREFIX = "tdjr-notes-device-";
    private static final Pattern ALIAS = Pattern.compile("[A-Za-z0-9_-]{8,64}");
    private static final int AUTHENTICATORS =
            BiometricManager.Authenticators.BIOMETRIC_STRONG | BiometricManager.Authenticators.DEVICE_CREDENTIAL;

    private static String b64url(byte[] bytes) {
        return Base64.encodeToString(bytes, Base64.URL_SAFE | Base64.NO_PADDING | Base64.NO_WRAP);
    }

    /** A coordinate as exactly 32 unsigned big-endian bytes. */
    private static byte[] coordinate(BigInteger value) {
        byte[] raw = value.toByteArray();
        byte[] out = new byte[32];
        int copy = Math.min(raw.length, 32);
        System.arraycopy(raw, raw.length - copy, out, 32 - copy, copy);
        return out;
    }

    private static String aliasOf(PluginCall call) {
        String alias = call.getString("alias", "");
        return ALIAS.matcher(alias).matches() ? PREFIX + alias : null;
    }

    private static KeyPair generate(String alias, boolean strongBox) throws Exception {
        KeyGenParameterSpec.Builder spec = new KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
                .setAlgorithmParameterSpec(new ECGenParameterSpec("secp256r1"))
                .setDigests(KeyProperties.DIGEST_SHA256)
                .setUserAuthenticationRequired(true)
                // Every signature needs its own check (no time window).
                .setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG | KeyProperties.AUTH_DEVICE_CREDENTIAL);
        if (strongBox && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) spec.setIsStrongBoxBacked(true);
        KeyPairGenerator generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, KEYSTORE);
        generator.initialize(spec.build());
        return generator.generateKeyPair();
    }

    @PluginMethod
    public void createKey(PluginCall call) {
        String alias = aliasOf(call);
        if (alias == null) {
            call.reject("Invalid key alias.");
            return;
        }
        try {
            KeyPair pair;
            try {
                pair = generate(alias, true);
            } catch (StrongBoxUnavailableException e) {
                pair = generate(alias, false);
            }
            ECPublicKey pub = (ECPublicKey) pair.getPublic();
            JSObject result = new JSObject();
            result.put("x", b64url(coordinate(pub.getW().getAffineX())));
            result.put("y", b64url(coordinate(pub.getW().getAffineY())));
            call.resolve(result);
        } catch (Exception e) {
            call.reject("Couldn't create this tablet's key. Is a screen lock set up?", e);
        }
    }

    @PluginMethod
    public void sign(PluginCall call) {
        String alias = aliasOf(call);
        byte[] data;
        try {
            data = Base64.decode(call.getString("data", ""), Base64.URL_SAFE);
        } catch (IllegalArgumentException e) {
            data = null;
        }
        if (alias == null || data == null) {
            call.reject("Invalid sign request.");
            return;
        }
        Signature signature;
        try {
            KeyStore store = KeyStore.getInstance(KEYSTORE);
            store.load(null);
            PrivateKey key = (PrivateKey) store.getKey(alias, null);
            if (key == null) {
                call.reject("This tablet has no key for that server. Request access again.", "NO_KEY");
                return;
            }
            signature = Signature.getInstance("SHA256withECDSA");
            signature.initSign(key);
        } catch (KeyPermanentlyInvalidatedException e) {
            call.reject("This tablet's key stopped working because its screen lock or fingerprints changed. Request access again.", "KEY_INVALIDATED");
            return;
        } catch (Exception e) {
            call.reject("Couldn't use this tablet's key.", e);
            return;
        }

        final byte[] toSign = data;
        BiometricPrompt.PromptInfo info = new BiometricPrompt.PromptInfo.Builder()
                .setTitle("Notes")
                .setSubtitle(call.getString("reason", "Confirm it's you"))
                .setAllowedAuthenticators(AUTHENTICATORS)
                .build();
        getActivity().runOnUiThread(() -> {
            BiometricPrompt prompt = new BiometricPrompt(getActivity(), ContextCompat.getMainExecutor(getContext()),
                    new BiometricPrompt.AuthenticationCallback() {
                        @Override
                        public void onAuthenticationSucceeded(@NonNull BiometricPrompt.AuthenticationResult result) {
                            try {
                                Signature unlocked = result.getCryptoObject().getSignature();
                                unlocked.update(toSign);
                                JSObject out = new JSObject();
                                out.put("signature", b64url(unlocked.sign()));
                                call.resolve(out);
                            } catch (Exception e) {
                                call.reject("Couldn't sign with this tablet's key.", e);
                            }
                        }

                        @Override
                        public void onAuthenticationError(int code, @NonNull CharSequence message) {
                            boolean cancelled = code == BiometricPrompt.ERROR_USER_CANCELED
                                    || code == BiometricPrompt.ERROR_NEGATIVE_BUTTON
                                    || code == BiometricPrompt.ERROR_CANCELED;
                            call.reject(cancelled ? "Sign-in was cancelled." : message.toString(), cancelled ? "CANCELLED" : "AUTH_ERROR");
                        }
                    });
            prompt.authenticate(info, new BiometricPrompt.CryptoObject(signature));
        });
    }
}
