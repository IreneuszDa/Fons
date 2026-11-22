import 'dart:async';
import 'dart:convert';

import 'package:crypto/crypto.dart';
import 'package:http/http.dart' as http;
import 'package:matrix/matrix.dart';
import 'package:mime/mime.dart';

/// Attach once to the dedicated, already authenticated ChatLoom client.
class FonsConnector {
  final Client client;
  final Uri webhook;
  final String _secret;
  final bool Function(Room) acceptsRoom;
  final String _account;
  final bool Function(Event) isOwnEvent;
  final String? Function(Event, String) supportedReaction;
  final void Function(String eventId, Object problem) onFailure;
  final http.Client _http;
  final _startedAtMs = DateTime.now().millisecondsSinceEpoch;
  final _queues = <String, Future<void>>{};
  final _forwardingPhotos = <String>{};
  late final StreamSubscription<dynamic> _subscription;
  bool _closed = false;

  FonsConnector({
    required this.client,
    required this.webhook,
    required String secret,
    required this.acceptsRoom,
    required String accountId,
    required this.isOwnEvent,
    required this.supportedReaction,
    required this.onFailure,
    http.Client? transport,
  }) : _account = accountId,
       _secret = secret,
       _http = transport ?? http.Client() {
    final loopback = {'localhost', '127.0.0.1', '::1'}.contains(webhook.host);
    if (!(webhook.scheme == 'https' ||
            (loopback && webhook.scheme == 'http')) ||
        webhook.host.isEmpty ||
        webhook.userInfo.isNotEmpty ||
        secret.isEmpty) {
      throw ArgumentError('Provide an HTTPS webhook and the operator secret.');
    }
    if (accountId.isEmpty || client.userID != accountId || !client.isLogged()) {
      throw StateError('The dedicated Fons account must be signed in.');
    }
    // This vendored SDK emits late decryption only on onEvent. History and
    // state updates share this stream and must be filtered before parsing.
    // ignore: deprecated_member_use
    _subscription = client.onEvent.stream.listen((update) {
      if (update.type != EventUpdateType.timeline &&
          update.type != EventUpdateType.decryptedTimelineQueue)
        return;
      final room = client.getRoomById(update.roomID);
      if (room == null || !_canUse(room) || client.prevBatch == null) return;
      final raw = update.content;
      if (!{
            EventTypes.Message,
            EventTypes.Reaction,
            EventTypes.Redaction,
          }.contains(raw['type']) ||
          raw['state_key'] != null ||
          raw['event_id'] is! String ||
          raw['sender'] is! String)
        return;
      final event = Event.fromJson(raw, room);
      if (!event.eventId.startsWith(r'$') ||
          !event.status.isSynced ||
          event.redacted ||
          event.originServerTs.millisecondsSinceEpoch < _startedAtMs ||
          event.senderId == _account ||
          isOwnEvent(event) ||
          event.senderId != room.directChatMatrixIDForDisplay)
        return;
      final content = _contentOf(event);
      if (content == null) return;
      // The previous question may be waiting for this photo at the webhook.
      if (content['msgtype'] == 'm.image') {
        if (!_forwardingPhotos.add(event.eventId)) return;
        unawaited(
          _deliver(
            event,
            content,
          ).whenComplete(() => _forwardingPhotos.remove(event.eventId)),
        );
        return;
      }
      final previous = _queues[room.id] ?? Future<void>.value();
      final turn = previous.then((_) => _deliver(event, content));
      _queues[room.id] = turn;
      unawaited(
        turn.whenComplete(() {
          if (identical(_queues[room.id], turn)) _queues.remove(room.id);
        }),
      );
    });
  }

  bool _canUse(Room room) =>
      !_closed &&
      client.isLogged() &&
      client.userID == _account &&
      identical(client.getRoomById(room.id), room) &&
      room.membership == Membership.join &&
      room.isDirectChatForDisplay &&
      acceptsRoom(room);

  static Map<String, Object?>? _contentOf(Event event) {
    final content = event.content;
    if (event.type == EventTypes.Redaction) {
      final target = content['redacts'] ?? event.redacts;
      return target is String ? {'redacts': target} : null;
    }
    final relation = content['m.relates_to'];
    if (event.type == EventTypes.Reaction) {
      if (relation is! Map ||
          relation['rel_type'] != 'm.annotation' ||
          relation['key'] is! String ||
          relation['event_id'] is! String)
        return null;
      return {
        'm.relates_to': {
          'rel_type': 'm.annotation',
          'event_id': relation['event_id'],
          'key': relation['key'],
        },
      };
    }
    if (relation is Map && relation['rel_type'] == 'm.replace') return null;
    final msgtype = content['msgtype'];
    if (msgtype != 'm.text' &&
        msgtype != 'm.image' &&
        msgtype != 'm.audio' &&
        msgtype != 'm.voice') {
      return null;
    }
    final reply = relation is Map ? relation['m.in_reply_to'] : null;
    final replyId = reply is Map ? reply['event_id'] : null;
    final body = content['body'];
    var text = body is String ? body : '';
    if (replyId is String) {
      text = text.replaceFirst(RegExp(r'^(?:>[^\n]*\r?\n)+\r?\n'), '');
    }
    final filename = content['filename'];
    if (msgtype == 'm.text' && text.trim().isEmpty) {
      return null;
    }
    return {
      'msgtype': msgtype,
      if (msgtype == 'm.text') 'body': text,
      if (msgtype == 'm.image' &&
          body is String &&
          filename is String &&
          body != filename &&
          body.trim().isNotEmpty)
        'caption': body,
      if (replyId is String && replyId.startsWith(r'$'))
        'm.relates_to': {
          'm.in_reply_to': {'event_id': replyId},
        },
    };
  }

  Future<Map<String, String>?> _readMedia(Event event, bool isPhoto) async {
    final limit = (isPhoto ? 5 : 20) * 1024 * 1024;
    final size = event.infoMap['size'];
    if (size is int && size > limit) return null;
    final file = await event
        .downloadAndDecryptAttachment(
          cacheAttachment: false,
          onDownloadProgress: (bytes) {
            if (bytes > limit)
              throw StateError('Fons attachment is too large.');
          },
        )
        .timeout(const Duration(seconds: 30));
    if (file.bytes.isEmpty || file.bytes.length > limit) return null;
    final originalMime = file.mimeType.split(';').first.trim().toLowerCase();
    final detectedMime = lookupMimeType('', headerBytes: file.bytes);
    const images = {'image/jpeg', 'image/png', 'image/webp'};
    const audio = {
      'audio/ogg',
      'audio/mp4',
      'audio/mpeg',
      'audio/wav',
      'audio/webm',
    };
    final declaredMime = switch (originalMime) {
      'application/ogg' || 'audio/opus' => 'audio/ogg',
      'audio/x-wav' => 'audio/wav',
      'video/mp4' || 'audio/x-m4a' || 'audio/m4a' => 'audio/mp4',
      _ => originalMime,
    };
    final allowed = isPhoto ? images : audio;
    final mime = allowed.contains(detectedMime) ? detectedMime! : declaredMime;
    if (!allowed.contains(mime)) return null;
    return {'mime': mime, 'base64': base64Encode(file.bytes)};
  }

  Future<void> _deliver(Event event, Map<String, Object?> content) async {
    final room = event.room;
    if (!_canUse(room) || event.senderId != room.directChatMatrixIDForDisplay) {
      return;
    }
    final msgtype = content['msgtype'];
    try {
      Map<String, String>? attachment;
      if (msgtype == 'm.image' ||
          msgtype == 'm.audio' ||
          msgtype == 'm.voice') {
        try {
          attachment = await _readMedia(event, msgtype == 'm.image');
        } catch (error) {
          if (!_closed) onFailure(event.eventId, error);
        }
      }
      if (!_canUse(room) ||
          event.senderId != room.directChatMatrixIDForDisplay) {
        return;
      }
      final body = jsonEncode({
        'room_id': room.id,
        'event_id': event.eventId,
        'sender': event.senderId,
        'origin_server_ts': event.originServerTs.millisecondsSinceEpoch,
        'type': event.type,
        'media_context': true,
        'content': {
          ...content,
          if (attachment != null) 'attachment': attachment,
        },
      });
      await _forward(event, body);
    } catch (error) {
      if (!_closed) onFailure(event.eventId, error);
    }
  }

  Future<void> _forward(Event event, String body) async {
    final room = event.room;
    final elapsed = Stopwatch()..start();
    const retryWindow = Duration(minutes: 10);
    for (var attempt = 0; _canUse(room); attempt++) {
      var waitSeconds = 1 << attempt.clamp(0, 5);
      try {
        final response = await _post(body).timeout(const Duration(minutes: 3));
        if (response.statusCode != 200) {
          if (response.statusCode == 501 ||
              (response.statusCode != 429 && response.statusCode < 500)) {
            throw FormatException(
              'Fons rejected the request (HTTP ${response.statusCode}).',
            );
          }
          final retryAfter = int.tryParse(
            response.headers['retry-after'] ?? '',
          );
          if (retryAfter != null && retryAfter > waitSeconds)
            waitSeconds = retryAfter.clamp(1, 600);
          throw StateError('Fons unavailable (HTTP ${response.statusCode}).');
        }
        final result = jsonDecode(utf8.decode(response.bodyBytes));
        if (result is! Map || result['actions'] is! List)
          throw const FormatException('Invalid Fons response.');
        for (final action in result['actions'] as List) {
          if (!_canUse(room) ||
              event.senderId != room.directChatMatrixIDForDisplay)
            return;
          await _send(event, action);
        }
        return;
      } on FormatException {
        rethrow;
      } catch (_) {
        final delay = Duration(seconds: waitSeconds);
        if (elapsed.elapsed + delay >= retryWindow) rethrow;
        await Future<void>.delayed(delay);
      }
    }
  }

  Future<http.Response> _post(String body) async {
    final stamp = DateTime.now().millisecondsSinceEpoch ~/ 1000;
    final signature = Hmac(
      sha256,
      utf8.encode(_secret),
    ).convert(utf8.encode('$stamp.$body'));
    final request = http.Request('POST', webhook)
      ..followRedirects = false
      ..headers.addAll({
        'content-type': 'application/json; charset=utf-8',
        'x-chatloom-timestamp': '$stamp',
        'x-chatloom-signature': '$signature',
      })
      ..bodyBytes = utf8.encode(body);
    return http.Response.fromStream(await _http.send(request));
  }

  Future<void> _send(Event event, dynamic action) async {
    if (action is! Map ||
        action['txn_id'] is! String ||
        action['content'] is! Map) {
      throw const FormatException('Invalid Fons action.');
    }
    final id = action['txn_id'] as String;
    final content = action['content'] as Map;
    final type = action['type'];
    late final Map<String, dynamic> outgoing;
    if (type == EventTypes.Message &&
        content['msgtype'] == 'm.text' &&
        content['body'] is String) {
      outgoing = {'msgtype': 'm.text', 'body': content['body']};
    } else if (type == EventTypes.Reaction) {
      final relation = content['m.relates_to'];
      if (relation is! Map ||
          relation['rel_type'] != 'm.annotation' ||
          relation['event_id'] != event.eventId ||
          relation['key'] is! String) {
        throw const FormatException('Invalid reaction target.');
      }
      final key = supportedReaction(event, relation['key'] as String);
      if (key == null) return;
      outgoing = {
        'm.relates_to': {
          'rel_type': 'm.annotation',
          'event_id': event.eventId,
          'key': key,
        },
      };
    } else {
      throw const FormatException('Unknown Fons action.');
    }
    final sent = await event.room.sendEvent(
      outgoing,
      type: type as String,
      txid: id,
      displayPendingEvent: false,
    );
    if (sent == null) throw StateError('ChatLoom did not accept the action.');
  }

  Future<void> close() async {
    _closed = true;
    _http.close();
    await _subscription.cancel();
  }
}

/// On the dedicated account, enroll direct conversations from the configured
/// bridge bots. The per-room state key can differ for every contact.
bool Function(Room) fonsBridgeRooms(Map<String, String> protocolByBot) {
  final allowed = Map<String, String>.unmodifiable(protocolByBot);
  return (room) {
    for (final type in [
      'm.bridge',
      'uk.half-shot.bridge',
      'com.beeper.bridge',
    ]) {
      for (final info in room.states[type]?.values ?? <StrippedStateEvent>[]) {
        final bot = info.senderId;
        final protocol = info.content['protocol'];
        if (allowed.containsKey(bot) &&
            info.content['bridgebot'] == bot &&
            protocol is Map &&
            protocol['id'] == allowed[bot] &&
            room.getState(EventTypes.RoomMember, bot)?.content['membership'] ==
                'join')
          return true;
      }
    }
    return false;
  };
}
