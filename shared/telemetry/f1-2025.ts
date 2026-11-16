
export interface F1GridEntry {
  position: number;
  driverId: number;
  teamId: number;
  name: string;
  /** Native car-slot/lap/rewind identity; optional for older stored packets. */
  carIndex?: number;
  timingEpoch?: number;
  currentLapNum?: number;
  currentSector?: number;
  currentS1?: number;
  currentS2?: number;
  currentLapValid?: boolean;
  resultStatus?: number;
  lastLapNumber?: number;
  currentLapTime: number;
  lastLapTime: number;
  bestLapTime: number;
  gapToLeader: number;
  gapToCarAhead: number;
  pitStatus: number;
  numPitStops: number;
  tyreCompound: string;
  tyreAge: number;
  penalties: number;
  // Coherent completed sectors in seconds; 0 means unavailable.
  bestS1: number;
  bestS2: number;
  bestS3: number;
  lastS1: number;
  lastS2: number;
  lastS3: number;
}

export interface F1ExtendedData {
  drsAllowed: boolean;
  drsActivated: boolean;
  drsZoneApproaching: boolean;
  ersStoreEnergy: number;
  ersDeployMode: number;
  ersDeployedThisLap: number;
  ersHarvestedThisLap: number;
  tyreCompound: string;
  tyreVisualCompound: number;
  tyreAge: number;
  weather: number;
  trackTemperature: number;
  airTemperature: number;
  rainPercentage: number;
  sessionType: string;
  totalLaps: number;
  currentSector: number; // 0=S1, 1=S2, 2=S3
  sector1Time: number; // seconds (0 if not completed this lap)
  sector2Time: number; // seconds (0 if not completed this lap)
  lastS1: number; // Matching completed prior-lap sectors (0 until coherent evidence arrives)
  lastS2: number;
  lastS3: number;
  /**
   * Current-epoch lap splits keyed by 1-indexed lap number, in seconds.
   * Native S1/S2 partials remain pending until a matching native last-lap
   * total or completed SessionHistory supplies S3. A positive coherent
   * lapTime is required before treating an entry as a completed lap.
   */
  lapSectors?: Record<number, { s1: number; s2: number; s3: number; lapTime: number }>;
  // Damage (0-100, 0=no damage)
  // Brake temps (Celsius)
  brakeTempFL: number;
  brakeTempFR: number;
  brakeTempRL: number;
  brakeTempRR: number;
  // Tyre pressures (PSI)
  tyrePressureFL: number;
  tyrePressureFR: number;
  tyrePressureRL: number;
  tyrePressureRR: number;
  // Damage (0-100, 0=no damage)
  frontLeftWingDamage: number;
  frontRightWingDamage: number;
  rearWingDamage: number;
  floorDamage: number;
  diffuserDamage: number;
  sidepodDamage: number;
  // Extended CarStatus fields
  tractionControl?: number;
  antiLockBrakes?: number;
  fuelMix?: number;
  frontBrakeBias?: number;
  pitLimiterStatus?: number;
  fuelRemainingLaps?: number;
  drsActivationDistance?: number;
  actualTyreCompound?: number;
  vehicleFIAFlags?: number;
  vehicleFIAFlagsUpdatedAt?: number;
  safetyCarStatusUpdatedAt?: number;
  /** Time of LGOT only when preceded by a positive STLG light-count event. */
  raceStartAt?: number;
  enginePowerICE?: number;
  enginePowerMGUK?: number;
  // Extended CarDamage fields
  tyresDamageFL?: number;
  tyresDamageFR?: number;
  tyresDamageRL?: number;
  tyresDamageRR?: number;
  brakesDamageFL?: number;
  brakesDamageFR?: number;
  brakesDamageRL?: number;
  brakesDamageRR?: number;
  tyreBlistersFL?: number;
  tyreBlistsFR?: number;
  tyreBlistersRL?: number;
  tyreBlistersRR?: number;
  drsFault?: number;
  ersFault?: number;
  gearBoxDamage?: number;
  engineDamage?: number;
  engineMGUHWear?: number;
  engineESWear?: number;
  engineCEWear?: number;
  engineICEWear?: number;
  engineMGUKWear?: number;
  engineTCWear?: number;
  // Extended CarTelemetry fields
  tyresInnerTempFL?: number;
  tyresInnerTempFR?: number;
  tyresInnerTempRL?: number;
  tyresInnerTempRR?: number;
  engineTemperature?: number;
  surfaceTypeFL?: number;
  surfaceTypeFR?: number;
  surfaceTypeRL?: number;
  surfaceTypeRR?: number;
  suggestedGear?: number;
  // Extended LapData fields
  currentLapInvalid?: number;
  penalties?: number;
  totalWarnings?: number;
  cornerCuttingWarnings?: number;
  driverStatus?: number;
  resultStatus?: number;
  resultReason?: number;
  resultSource?: "lap-data" | "final-classification" | "event";
  pitLaneTimerActive?: number;
  pitLaneTimeInLaneInMS?: number;
  speedTrapFastestSpeed?: number;
  gridPosition?: number;
  // Extended Session fields
  safetyCarStatus?: number;
  trackLength?: number;
  pitSpeedLimit?: number;
  formula?: number;
  sector2LapDistanceStart?: number;
  sector3LapDistanceStart?: number;
  pitStopWindowIdealLap?: number;
  pitStopWindowLatestLap?: number;
  grid: F1GridEntry[];
  // Car setup (from PacketCarSetupData, packet ID 5)
  setup?: F1CarSetup;
  // MotionEx — per-packet detailed physics
  motionEx?: {
    wheelSlipAngleFL: number; wheelSlipAngleFR: number;
    wheelSlipAngleRL: number; wheelSlipAngleRR: number;
    wheelLatForceFL: number; wheelLatForceFR: number;
    wheelLatForceRL: number; wheelLatForceRR: number;
    wheelLongForceFL: number; wheelLongForceFR: number;
    wheelLongForceRL: number; wheelLongForceRR: number;
    wheelVertForceFL: number; wheelVertForceFR: number;
    wheelVertForceRL: number; wheelVertForceRR: number;
    frontWheelsAngle: number;
    frontAeroHeight: number; rearAeroHeight: number;
    frontRollAngle: number; rearRollAngle: number;
    chassisYaw: number; chassisPitch: number;
    heightOfCOGAboveGround: number;
  };
}

export interface F1CarSetup {
  frontWing: number;
  rearWing: number;
  onThrottle: number;       // differential on-throttle %
  offThrottle: number;      // differential off-throttle %
  frontCamber: number;      // degrees (negative)
  rearCamber: number;       // degrees (negative)
  frontToe: number;         // degrees
  rearToe: number;          // degrees
  frontSuspension: number;  // 1-11
  rearSuspension: number;   // 1-11
  frontAntiRollBar: number; // 1-11
  rearAntiRollBar: number;  // 1-11
  frontRideHeight: number;  // 1-50
  rearRideHeight: number;   // 1-50
  brakePressure: number;    // %
  brakeBias: number;        // %
  engineBraking: number;    // %
  rearLeftTyrePressure: number;   // PSI
  rearRightTyrePressure: number;  // PSI
  frontLeftTyrePressure: number;  // PSI
  frontRightTyrePressure: number; // PSI
  fuelLoad: number;         // kg
}
