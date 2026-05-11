import AVFAudio
import Foundation

protocol AudioSessionControlling: Sendable {
    func prepareForVoiceChat() async throws -> VoiceChatAudioConfig
    func deactivate() async
}

enum AudioSessionError: LocalizedError, Equatable {
    case microphoneDenied

    var errorDescription: String? {
        switch self {
        case .microphoneDenied:
            return "Microphone access denied. Enable microphone access in Settings."
        }
    }
}

struct AudioSessionController: AudioSessionControlling {
    func prepareForVoiceChat() async throws -> VoiceChatAudioConfig {
        guard await requestMicrophonePermission() else {
            throw AudioSessionError.microphoneDenied
        }

        let session = AVAudioSession.sharedInstance()
        try session.setCategory(
            .playAndRecord,
            mode: .voiceChat,
            options: [.allowBluetooth, .allowBluetoothA2DP, .defaultToSpeaker]
        )
        try session.setActive(true)

        let speakerRisk = session.currentRoute.outputs.allSatisfy { output in
            switch output.portType {
            case .bluetoothA2DP, .bluetoothHFP, .bluetoothLE,
                .headphones, .usbAudio, .carAudio:
                return false
            default:
                return true
            }
        }

        return VoiceChatAudioConfig(
            noiseReduction: speakerRisk ? .nearField : .farField,
            bargeInMode: speakerRisk ? .transcriptConfirmed : .speechStarted
        )
    }

    func deactivate() async {
        try? AVAudioSession.sharedInstance().setActive(
            false,
            options: [.notifyOthersOnDeactivation]
        )
    }

    private func requestMicrophonePermission() async -> Bool {
        if #available(iOS 17.0, *) {
            return await withCheckedContinuation { continuation in
                AVAudioApplication.requestRecordPermission { granted in
                    continuation.resume(returning: granted)
                }
            }
        }

        return await withCheckedContinuation { continuation in
            AVAudioSession.sharedInstance().requestRecordPermission { granted in
                continuation.resume(returning: granted)
            }
        }
    }
}
