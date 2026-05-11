import XCTest
@testable import Zero

final class RealtimeEventParserTests: XCTestCase {
    func testParsesResponseDoneUsage() throws {
        let json = """
        {
          "type": "response.done",
          "event_id": "evt_1",
          "response": {
            "id": "resp_1",
            "status": "completed",
            "usage": {
              "input_token_details": {
                "text_tokens": 11,
                "audio_tokens": 22,
                "cached_tokens_details": {
                  "text_tokens": 3,
                  "audio_tokens": 4
                }
              },
              "output_token_details": {
                "text_tokens": 5,
                "audio_tokens": 6
              }
            }
          }
        }
        """

        let action = try RealtimeEventParser().parse(json)

        XCTAssertEqual(
            action,
            .responseDone(
                VoiceChatUsageEvent(
                    providerEventId: "evt_1",
                    eventType: .responseDone,
                    inputTextTokens: 11,
                    inputAudioTokens: 22,
                    inputCachedTextTokens: 3,
                    inputCachedAudioTokens: 4,
                    outputTextTokens: 5,
                    outputAudioTokens: 6
                )
            )
        )
    }

    func testParsesTranscriptionCompletedUsage() throws {
        let json = """
        {
          "type": "conversation.item.input_audio_transcription.completed",
          "item_id": "item_1",
          "content_index": 0,
          "transcript": "hello",
          "usage": {
            "type": "tokens",
            "input_token_details": {
              "text_tokens": 7,
              "audio_tokens": 8
            },
            "output_tokens": 9
          }
        }
        """

        let action = try RealtimeEventParser().parse(json)

        XCTAssertEqual(
            action,
            .userTranscriptCompleted(
                itemId: "item_1",
                transcript: "hello",
                usage: VoiceChatUsageEvent(
                    providerEventId: "item_1:0",
                    eventType: .transcriptionCompleted,
                    inputTextTokens: 7,
                    inputAudioTokens: 8,
                    inputCachedTextTokens: nil,
                    inputCachedAudioTokens: nil,
                    outputTextTokens: 9,
                    outputAudioTokens: nil
                )
            )
        )
    }

    func testParsesFunctionCallArguments() throws {
        let json = """
        {
          "type": "response.function_call_arguments.done",
          "name": "inform_slow_brain",
          "call_id": "call_1",
          "arguments": "{\\"prompt\\":\\"make a task\\"}"
        }
        """

        let action = try RealtimeEventParser().parse(json)

        XCTAssertEqual(
            action,
            .functionCall(
                name: "inform_slow_brain",
                callId: "call_1",
                arguments: "{\"prompt\":\"make a task\"}"
            )
        )
    }
}
