import Testing

@testable import ScreenRecorderCore

struct CaptureGeometryTests {
    @Test
    func keepsRetinaCapturesBelowTheCapAtNativeSize() {
        let geometry = CaptureGeometry(
            originX: 0,
            originY: 0,
            widthPoints: 900,
            heightPoints: 600,
            scale: 2
        )

        let size = CaptureSizePolicy.outputSize(for: geometry)

        #expect(size == OutputSize(width: 1800, height: 1200))
    }

    @Test
    func capsWideCapturesAndPreservesAspectRatio() {
        // A 16:10 Retina display: 3024x1890 native pixels.
        let geometry = CaptureGeometry(
            originX: 0,
            originY: 0,
            widthPoints: 1512,
            heightPoints: 945,
            scale: 2
        )

        let size = CaptureSizePolicy.outputSize(for: geometry)

        #expect(size.width == 1920)
        #expect(size.height == 1200)
        let nativeRatio = 3024.0 / 1890.0
        let outputRatio = Double(size.width) / Double(size.height)
        #expect(abs(nativeRatio - outputRatio) < 0.01)
    }

    @Test
    func alwaysProducesEvenDimensionsForH264() {
        // 1001x667 points at 1x would round to odd pixel counts.
        let geometry = CaptureGeometry(
            originX: 12,
            originY: 34,
            widthPoints: 1001,
            heightPoints: 667,
            scale: 1
        )

        let size = CaptureSizePolicy.outputSize(for: geometry)

        #expect(size.width % 2 == 0)
        #expect(size.height % 2 == 0)
    }

    @Test
    func clampsDegenerateRegionsToAnEncodableMinimum() {
        let geometry = CaptureGeometry(
            originX: 0,
            originY: 0,
            widthPoints: 0,
            heightPoints: 0,
            scale: 2
        )

        let size = CaptureSizePolicy.outputSize(for: geometry)

        #expect(size == OutputSize(width: 2, height: 2))
    }

    @Test
    func reportsNativeSizeSeparatelyFromTheCappedOutput() {
        let geometry = CaptureGeometry(
            originX: 0,
            originY: 0,
            widthPoints: 1512,
            heightPoints: 945,
            scale: 2
        )

        #expect(
            CaptureSizePolicy.nativePixelSize(for: geometry)
                == OutputSize(width: 3024, height: 1890)
        )
    }
}
