package dev.expenses.googleauthorization

import android.accounts.Account
import android.app.Activity
import com.google.android.gms.auth.api.identity.AuthorizationRequest
import com.google.android.gms.auth.api.identity.AuthorizationResult
import com.google.android.gms.auth.api.identity.ClearTokenRequest
import com.google.android.gms.auth.api.identity.Identity
import com.google.android.gms.auth.api.identity.RevokeAccessRequest
import com.google.android.gms.common.api.ApiException
import com.google.android.gms.common.api.CommonStatusCodes
import com.google.android.gms.common.api.Scope
import expo.modules.kotlin.Promise
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

private const val REQUEST_CODE_AUTHORIZE = 0x4741
private const val GOOGLE_ACCOUNT_TYPE = "com.google"

// AuthorizationRequest.Prompt.SELECT_ACCOUNT. Prompt is a Java @IntDef
// annotation; its value (2) was read from the play-services-auth 22.0.0 class file.
private const val PROMPT_SELECT_ACCOUNT = 2

/**
 * Thin wrapper over Google Identity Services AuthorizationClient.
 *
 * Returns OAuth access tokens for the requested scopes. Tokens are cached and
 * refreshed by Google Play services; this module never stores them. Nothing
 * here logs tokens, account names or scopes.
 */
class GoogleAuthorizationModule : Module() {
  // At most one consent screen is shown at a time.
  private var pendingInteractive: Promise? = null

  override fun definition() = ModuleDefinition {
    Name("ExpoGoogleAuthorization")

    AsyncFunction("authorize") { scopes: List<String>, accountEmail: String?, interactive: Boolean, selectAccount: Boolean, promise: Promise ->
      val activity = appContext.currentActivity
      if (activity == null) {
        promise.reject("ERR_NO_ACTIVITY", "The app is not in the foreground", null)
        return@AsyncFunction
      }
      if (scopes.isEmpty()) {
        promise.reject("ERR_INVALID_ARGUMENT", "At least one scope is required", null)
        return@AsyncFunction
      }

      val builder = AuthorizationRequest.builder().setRequestedScopes(scopes.map { Scope(it) })
      if (selectAccount) {
        builder.setPrompt(PROMPT_SELECT_ACCOUNT)
      } else if (!accountEmail.isNullOrEmpty()) {
        builder.setAccount(Account(accountEmail, GOOGLE_ACCOUNT_TYPE))
      }

      Identity.getAuthorizationClient(activity)
        .authorize(builder.build())
        .addOnSuccessListener { result ->
          if (!result.hasResolution()) {
            resolveSuccess(promise, result)
            return@addOnSuccessListener
          }
          if (!interactive) {
            promise.resolve(mapOf("type" to "needs_user_interaction"))
            return@addOnSuccessListener
          }
          val pendingIntent = result.pendingIntent
          if (pendingIntent == null) {
            promise.reject("ERR_AUTHORIZATION", "Google did not provide a consent screen", null)
            return@addOnSuccessListener
          }
          if (pendingInteractive != null) {
            promise.reject("ERR_IN_PROGRESS", "Another Google authorization is already open", null)
            return@addOnSuccessListener
          }
          pendingInteractive = promise
          try {
            @Suppress("DEPRECATION")
            activity.startIntentSenderForResult(
              pendingIntent.intentSender, REQUEST_CODE_AUTHORIZE, null, 0, 0, 0, null
            )
          } catch (e: Exception) {
            pendingInteractive = null
            promise.reject("ERR_AUTHORIZATION", "Could not open the Google consent screen", e)
          }
        }
        .addOnFailureListener { error -> rejectWithApiError(promise, error) }
    }.runOnQueue(Queues.MAIN)

    OnActivityResult { activity, payload ->
      if (payload.requestCode != REQUEST_CODE_AUTHORIZE) return@OnActivityResult
      val promise = pendingInteractive ?: return@OnActivityResult
      pendingInteractive = null

      val data = payload.data
      if (payload.resultCode != Activity.RESULT_OK || data == null) {
        promise.resolve(mapOf("type" to "cancelled"))
        return@OnActivityResult
      }
      try {
        val result = Identity.getAuthorizationClient(activity).getAuthorizationResultFromIntent(data)
        resolveSuccess(promise, result)
      } catch (error: Exception) {
        rejectWithApiError(promise, error)
      }
    }

    AsyncFunction("clearToken") { token: String, promise: Promise ->
      val context = appContext.reactContext
      if (context == null) {
        promise.reject("ERR_NO_CONTEXT", "The app context is not available", null)
        return@AsyncFunction
      }
      Identity.getAuthorizationClient(context)
        .clearToken(ClearTokenRequest.builder().setToken(token).build())
        .addOnSuccessListener { promise.resolve() }
        .addOnFailureListener { error -> rejectWithApiError(promise, error) }
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("revokeAccess") { accountEmail: String, scopes: List<String>, promise: Promise ->
      val context = appContext.reactContext
      if (context == null) {
        promise.reject("ERR_NO_CONTEXT", "The app context is not available", null)
        return@AsyncFunction
      }
      val request = RevokeAccessRequest.builder()
        .setAccount(Account(accountEmail, GOOGLE_ACCOUNT_TYPE))
        .setScopes(scopes.map { Scope(it) })
        .build()
      Identity.getAuthorizationClient(context)
        .revokeAccess(request)
        .addOnSuccessListener { promise.resolve() }
        .addOnFailureListener { error -> rejectWithApiError(promise, error) }
    }.runOnQueue(Queues.MAIN)
  }

  private fun resolveSuccess(promise: Promise, result: AuthorizationResult) {
    val token = result.accessToken
    if (token.isNullOrEmpty()) {
      promise.reject("ERR_AUTHORIZATION", "Google returned no access token", null)
      return
    }
    promise.resolve(
      mapOf(
        "type" to "success",
        "accessToken" to token,
        "grantedScopes" to result.grantedScopes
      )
    )
  }

  private fun rejectWithApiError(promise: Promise, error: Exception) {
    if (error !is ApiException) {
      promise.reject("ERR_AUTHORIZATION", "Google authorization failed", error)
      return
    }
    when (error.statusCode) {
      CommonStatusCodes.CANCELED -> promise.resolve(mapOf("type" to "cancelled"))
      CommonStatusCodes.SIGN_IN_REQUIRED -> promise.resolve(mapOf("type" to "needs_user_interaction"))
      CommonStatusCodes.NETWORK_ERROR -> promise.reject("ERR_NETWORK", "No network connection", error)
      // Package name / SHA-1 not registered for an Android OAuth client.
      CommonStatusCodes.DEVELOPER_ERROR -> promise.reject("ERR_DEVELOPER_ERROR", "Google OAuth client is not configured for this build", error)
      else -> promise.reject("ERR_API_${error.statusCode}", "Google authorization failed", error)
    }
  }
}
