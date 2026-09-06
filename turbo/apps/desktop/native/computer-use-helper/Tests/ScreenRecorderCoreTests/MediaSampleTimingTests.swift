#if canImport(CoreMedia)
import AudioToolbox
import AVFoundation
import CoreMedia
import Foundation
import Testing

@testable import ScreenRecorderCore

struct MediaSampleTimingTests {
    @Test
    func trimsNonInterleavedStereoWithoutMixingOrChangingChannels() throws {
        let format = try #require(AVAudioFormat(
            commonFormat: .pcmFormatFloat32, sampleRate: 48000, channels: 2, interleaved: false
        ))
        let pcm = try #require(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 960))
        pcm.frameLength = 960
        let channels = try #require(pcm.floatChannelData)
        for index in 0..<960 {
            channels[0][index] = Float(index) / 1000
            channels[1][index] = -Float(index) / 1000
        }
        var timing = CMSampleTimingInfo(
            duration: CMTime(value: 1, timescale: 48000),
            presentationTimeStamp: CMTime(seconds: 100, preferredTimescale: 48000), decodeTimeStamp: .invalid
        )
        var source: CMSampleBuffer?
        #expect(CMSampleBufferCreate(
            allocator: kCFAllocatorDefault, dataBuffer: nil, dataReady: false,
            makeDataReadyCallback: nil, refcon: nil, formatDescription: format.formatDescription,
            sampleCount: 960, sampleTimingEntryCount: 1, sampleTimingArray: &timing,
            sampleSizeEntryCount: 0, sampleSizeArray: nil, sampleBufferOut: &source
        ) == noErr)
        let sample = try #require(source)
        #expect(CMSampleBufferSetDataBufferFromAudioBufferList(
            sample, blockBufferAllocator: kCFAllocatorDefault, blockBufferMemoryAllocator: kCFAllocatorDefault,
            flags: 0, bufferList: pcm.audioBufferList
        ) == noErr)
        #expect(CMSampleBufferSetDataReady(sample) == noErr)
        let pieces = try #require(MediaSampleTiming.audioSegments(
            sample, anchor: CMTime(seconds: 100, preferredTimescale: 48000),
            pauses: PauseTimeline(), captureEnd: 0.012
        ))
        let piece = try #require(pieces.first)
        #expect(CMSampleBufferGetNumSamples(piece) == 576)
        let output = try #require(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 576))
        output.frameLength = 576
        #expect(CMSampleBufferCopyPCMDataIntoAudioBufferList(
            piece, at: 0, frameCount: 576, into: output.mutableAudioBufferList
        ) == noErr)
        let copied = try #require(output.floatChannelData)
        for index in 0..<576 {
            #expect(copied[0][index] == channels[0][index])
            #expect(copied[1][index] == channels[1][index])
        }
        let retimed = try #require(MediaSampleTiming.retimed(piece, to: .zero))
        #expect(abs(CMSampleBufferGetDuration(retimed).seconds - 0.012) < 0.000_000_001)
    }

    @Test
    func retimingTwentyMillisecondsPreservesDurationAndAudioFrames() throws {
        let original = try audioBuffer()
        let copy = try #require(MediaSampleTiming.retimed(original, to: CMTime(seconds: 200, preferredTimescale: 48000)))
        #expect(CMSampleBufferGetNumSamples(copy) == 960)
        #expect(abs(CMSampleBufferGetDuration(copy).seconds - 0.02) < 0.000_000_001)
        #expect(CMSampleBufferGetPresentationTimeStamp(copy).seconds == 200)
        #expect(try samples(copy) == samples(original))
    }

    @Test
    func trimsTheRealAudioAtTheStopBoundary() throws {
        let pieces = try #require(MediaSampleTiming.audioSegments(
            audioBuffer(), anchor: CMTime(seconds: 100, preferredTimescale: 48000),
            pauses: PauseTimeline(), captureEnd: 0.012
        ))
        #expect(pieces.count == 1)
        let piece = try #require(pieces.first)
        #expect(CMSampleBufferGetNumSamples(piece) == 576)
        #expect(try samples(piece) == Array(0..<576).map(Int16.init))
        #expect(abs(CMSampleBufferGetDuration(piece).seconds - 0.012) < 0.000_000_001)
    }

    @Test
    func keepsBothSidesOfAPauseFromOneLateBuffer() throws {
        var pauses = PauseTimeline()
        pauses.pause(at: 0.005)
        pauses.resume(at: 0.012)
        let pieces = try #require(MediaSampleTiming.audioSegments(
            audioBuffer(), anchor: CMTime(seconds: 100, preferredTimescale: 48000),
            pauses: pauses, captureEnd: nil
        ))
        #expect(pieces.count == 2)
        guard pieces.count == 2 else { return }
        #expect(try samples(pieces[0]) == Array(0..<240).map(Int16.init))
        #expect(try samples(pieces[1]) == Array(576..<960).map(Int16.init))
        #expect(abs(CMSampleBufferGetPresentationTimeStamp(pieces[1]).seconds - 100.012) < 0.000_000_001)
    }

    @Test
    func excludesAudioFromAnOpenPauseAndBeforeTheVideoAnchor() throws {
        var pauses = PauseTimeline()
        pauses.pause(at: 0.015)
        let pieces = try #require(MediaSampleTiming.audioSegments(
            audioBuffer(), anchor: CMTime(seconds: 100.01, preferredTimescale: 48000),
            pauses: pauses, captureEnd: 0.004
        ))
        #expect(pieces.count == 1)
        let piece = try #require(pieces.first)
        #expect(try samples(piece) == Array(480..<672).map(Int16.init))
        pauses = PauseTimeline()
        pauses.pause(at: 0.005)
        let paused = try #require(MediaSampleTiming.audioSegments(
            audioBuffer(), anchor: CMTime(seconds: 100, preferredTimescale: 48000),
            pauses: pauses, captureEnd: 4
        ))
        #expect(try samples(#require(paused.first)) == Array(0..<240).map(Int16.init))
    }

    private func audioBuffer() throws -> CMSampleBuffer {
        var format = AudioStreamBasicDescription(
            mSampleRate: 48000, mFormatID: kAudioFormatLinearPCM,
            mFormatFlags: kAudioFormatFlagIsSignedInteger | kAudioFormatFlagIsPacked,
            mBytesPerPacket: 2, mFramesPerPacket: 1, mBytesPerFrame: 2,
            mChannelsPerFrame: 1, mBitsPerChannel: 16, mReserved: 0
        )
        var description: CMAudioFormatDescription?
        #expect(CMAudioFormatDescriptionCreate(
            allocator: kCFAllocatorDefault, asbd: &format, layoutSize: 0, layout: nil,
            magicCookieSize: 0, magicCookie: nil, extensions: nil, formatDescriptionOut: &description
        ) == noErr)
        var block: CMBlockBuffer?
        #expect(CMBlockBufferCreateWithMemoryBlock(
            allocator: kCFAllocatorDefault, memoryBlock: nil, blockLength: 1920,
            blockAllocator: kCFAllocatorDefault, customBlockSource: nil,
            offsetToData: 0, dataLength: 1920, flags: 0, blockBufferOut: &block
        ) == noErr)
        let data = try #require(block)
        let values = Array(0..<960).map(Int16.init)
        #expect(values.withUnsafeBytes {
            CMBlockBufferReplaceDataBytes(with: $0.baseAddress!, blockBuffer: data, offsetIntoDestination: 0, dataLength: $0.count)
        } == noErr)
        var timing = CMSampleTimingInfo(
            duration: CMTime(value: 1, timescale: 48000),
            presentationTimeStamp: CMTime(seconds: 100, preferredTimescale: 48000), decodeTimeStamp: .invalid
        )
        var size = 2
        var sample: CMSampleBuffer?
        #expect(CMSampleBufferCreateReady(
            allocator: kCFAllocatorDefault, dataBuffer: data, formatDescription: description,
            sampleCount: 960, sampleTimingEntryCount: 1, sampleTimingArray: &timing,
            sampleSizeEntryCount: 1, sampleSizeArray: &size, sampleBufferOut: &sample
        ) == noErr)
        return try #require(sample)
    }

    private func samples(_ sample: CMSampleBuffer) throws -> [Int16] {
        let buffer = try #require(CMSampleBufferGetDataBuffer(sample))
        var values = [Int16](repeating: 0, count: CMSampleBufferGetNumSamples(sample))
        #expect(values.withUnsafeMutableBytes {
            CMBlockBufferCopyDataBytes(buffer, atOffset: 0, dataLength: $0.count, destination: $0.baseAddress!)
        } == noErr)
        return values
    }
}
#endif
