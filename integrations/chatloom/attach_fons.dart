import 'package:chatloom/personal/capabilities.dart';
import 'package:chatloom/personal/own_sender.dart';
import 'package:matrix/matrix.dart';

import 'fons_connector.dart';

FonsConnector attachFons({
  required Client client,
  required String operatorMatrixId,
  required Uri webhook,
  required String operatorSecret,
  required Map<String, String> protocolByBot,
}) => FonsConnector(
  client: client,
  accountId: operatorMatrixId,
  webhook: webhook,
  secret: operatorSecret,
  acceptsRoom: fonsBridgeRooms(protocolByBot),
  isOwnEvent: OwnSenderResolver.of(client).isOwnEvent,
  supportedReaction: (event, key) {
    final room = event.room;
    final declared = RoomCapabilities.declared(room);
    // Apple tapbacks and some bridges support a limited emoji set.
    final candidates = [key, if (key == '✅') '👍', if (key == '❌') '👎'];
    for (final candidate in candidates) {
      final spelling = declared.reactionSpelling(candidate);
      if (spelling != null &&
          RoomCapabilities.forFeature(
            BridgeFeature.reaction,
            room,
            event: event,
            reaction: spelling,
          ).allowed)
        return spelling;
    }
    return null;
  },
  onFailure: (id, problem) =>
      Logs().w('Fons delivery failed ($id, ${problem.runtimeType})'),
);
