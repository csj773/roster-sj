# Kakao Login Setup

This project uses Kakao Login by converting a Kakao access token into a Firebase custom token.

## Backend Endpoint

### Redirect login for FlutterFlow Web

Start URL:

```text
GET /api/kakaoStart?returnTo=https%3A%2F%2Flogbook-tljs60.flutterflow.app%2Fauth3
```

Callback URL to register in Kakao Developers:

```text
https://<your-vercel-project>.vercel.app/api/kakaoCallback
```

The callback returns a small HTML page that sends this message to the opener:

```json
{
  "type": "pilotlog:kakaoAuth",
  "ok": true,
  "firebaseCustomToken": "<Firebase custom token>",
  "uid": "kakao_123456789",
  "email": "user@example.com",
  "displayName": "nickname"
}
```

### Access-token exchange

Vercel endpoint:

```text
POST /api/kakaoAuth
```

Headers:

```text
Content-Type: application/json
x-api-key: <KAKAO_AUTH_API_KEY or ROSTER_API_KEY>
```

Body:

```json
{
  "kakaoAccessToken": "<Kakao access token>"
}
```

Response:

```json
{
  "ok": true,
  "firebaseCustomToken": "<Firebase custom token>",
  "uid": "kakao_123456789",
  "email": "user@example.com",
  "displayName": "nickname"
}
```

## Vercel Environment Variables

Add these to the Vercel project:

```text
KAKAO_AUTH_API_KEY=<long random value>
KAKAO_REST_API_KEY=<Kakao REST API key>
KAKAO_OAUTH_STATE_SECRET=<long random value>
KAKAO_RETURN_TO=https://logbook-tljs60.flutterflow.app/auth3
KAKAO_REDIRECT_URI=https://<your-vercel-project>.vercel.app/api/kakaoCallback
FIREBASE_SERVICE_ACCOUNT=<Firebase service account JSON>
CORS_ORIGINS=https://logbook-tljs60.flutterflow.app,https://logbook-tljs60.web.app,https://logbook-tljs60.firebaseapp.com
```

`KAKAO_AUTH_API_KEY` can be omitted if `ROSTER_API_KEY` is already set and should be reused.

## Kakao Developers

In Kakao Developers:

1. Create or open the app.
2. Enable Kakao Login.
3. Add this web platform site domain:

```text
https://logbook-tljs60.flutterflow.app
```

4. Add this redirect URI:

```text
https://<your-vercel-project>.vercel.app/api/kakaoCallback
```

5. Enable consent items needed by the app, normally profile nickname and email.

Kakao JavaScript SDK also requires the site domain to be registered under the
JavaScript key settings.

## FlutterFlow Flow

### Recommended Web Custom Action

Use this if the deployed app is FlutterFlow Web.

Custom action:

```dart
// Automatic FlutterFlow imports
import '/backend/backend.dart';
import '/backend/schema/structs/index.dart';
import '/flutter_flow/flutter_flow_theme.dart';
import '/flutter_flow/flutter_flow_util.dart';
import '/custom_code/actions/index.dart';
import '/flutter_flow/custom_functions.dart';
import 'package:flutter/material.dart';
// Begin custom action code
// DO NOT REMOVE OR MODIFY THE CODE ABOVE!

import 'dart:async';
import 'dart:convert';
import 'dart:html' as html;
import 'package:firebase_auth/firebase_auth.dart';

Future<String> signInWithKakaoWeb(String kakaoStartUrl) async {
  final completer = Completer<Map<String, dynamic>>();
  late html.EventListener listener;

  listener = (event) {
    final message = event as html.MessageEvent;
    final data = message.data;
    if (data is Map && data['type'] == 'pilotlog:kakaoAuth') {
      html.window.removeEventListener('message', listener);
      completer.complete(Map<String, dynamic>.from(data));
    }
  };

  html.window.addEventListener('message', listener);

  final popup = html.window.open(
    kakaoStartUrl,
    'kakaoLogin',
    'width=480,height=720,menubar=no,toolbar=no,location=no,status=no',
  );

  if (popup == null) {
    html.window.removeEventListener('message', listener);
    throw Exception('Kakao login popup was blocked');
  }

  final data = await completer.future.timeout(
    const Duration(minutes: 3),
    onTimeout: () {
      html.window.removeEventListener('message', listener);
      throw Exception('Kakao login timed out');
    },
  );

  if (data['ok'] != true) {
    throw Exception('Kakao login failed: ${jsonEncode(data)}');
  }

  final customToken = data['firebaseCustomToken'] as String?;
  if (customToken == null || customToken.isEmpty) {
    throw Exception('Missing Firebase custom token');
  }

  final credential = await FirebaseAuth.instance.signInWithCustomToken(customToken);
  return credential.user?.uid ?? '';
}
```

Argument:

```text
kakaoStartUrl: https://<your-vercel-project>.vercel.app/api/kakaoStart?returnTo=https%3A%2F%2Flogbook-tljs60.flutterflow.app%2Fauth3
```

Action output:

```text
String
```

The returned value is the signed-in Firebase UID.

### Optional Flutter SDK Custom Action

Use this only if FlutterFlow accepts the Kakao Flutter SDK for the target platform.

1. Add this dependency in FlutterFlow custom code dependencies:

```yaml
kakao_flutter_sdk_user: ^2.0.0
```

2. Use a FlutterFlow custom action to get a Kakao access token, call this
   backend, and sign in to Firebase with the returned custom token.

Custom action:

```dart
// Automatic FlutterFlow imports
import '/backend/backend.dart';
import '/backend/schema/structs/index.dart';
import '/flutter_flow/flutter_flow_theme.dart';
import '/flutter_flow/flutter_flow_util.dart';
import '/custom_code/actions/index.dart';
import '/flutter_flow/custom_functions.dart';
import 'package:flutter/material.dart';
// Begin custom action code
// DO NOT REMOVE OR MODIFY THE CODE ABOVE!

import 'dart:convert';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:http/http.dart' as http;
import 'package:kakao_flutter_sdk_user/kakao_flutter_sdk_user.dart';

Future<String> signInWithKakao(
  String kakaoNativeAppKey,
  String kakaoJavaScriptAppKey,
  String kakaoAuthEndpoint,
  String kakaoAuthApiKey,
) async {
  KakaoSdk.init(
    nativeAppKey: kakaoNativeAppKey,
    javaScriptAppKey: kakaoJavaScriptAppKey,
  );

  final OAuthToken kakaoToken;
  if (await isKakaoTalkInstalled()) {
    kakaoToken = await UserApi.instance.loginWithKakaoTalk();
  } else {
    kakaoToken = await UserApi.instance.loginWithKakaoAccount();
  }

  final response = await http.post(
    Uri.parse(kakaoAuthEndpoint),
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': kakaoAuthApiKey,
    },
    body: jsonEncode({
      'kakaoAccessToken': kakaoToken.accessToken,
    }),
  );

  if (response.statusCode != 200) {
    throw Exception('Kakao Firebase login failed: ${response.body}');
  }

  final data = jsonDecode(response.body) as Map<String, dynamic>;
  final customToken = data['firebaseCustomToken'] as String?;
  if (customToken == null || customToken.isEmpty) {
    throw Exception('Missing Firebase custom token');
  }

  final credential = await FirebaseAuth.instance.signInWithCustomToken(customToken);
  return credential.user?.uid ?? '';
}
```

Arguments:

```text
kakaoNativeAppKey: Kakao native app key
kakaoJavaScriptAppKey: Kakao JavaScript app key
kakaoAuthEndpoint: https://<your-vercel-project>.vercel.app/api/kakaoAuth
kakaoAuthApiKey: same value as KAKAO_AUTH_API_KEY
```

Action output:

```text
String
```

The returned value is the signed-in Firebase UID.

3. Connect the FlutterFlow Kakao button to this custom action.

The Firebase user UID will be:

```text
kakao_<Kakao numeric user id>
```

## Flow Summary

1. FlutterFlow gets Kakao access token from Kakao SDK.
2. Call `/api/kakaoAuth` with that access token.
3. Sign in to Firebase with the returned `firebaseCustomToken`.
