import React, { useState, useEffect, useMemo } from 'react';
import { PackageItem, Unit, Carrier, ShelfLetter, ShelfLevel, StorageLocation } from '../types';
import { CARRIER_CONFIG, SAMPLE_PACKAGE_PHOTOS, getSmartShelfSuggestion } from '../data/mockData';
import {
  Shield,
  Search,
  Camera,
  CheckCircle2,
  Sparkles,
  User,
  Clock,
  MapPin,
  RefreshCw,
  Check,
  ScanLine,
  Zap,
  AlertCircle,
  PauseCircle,
  PlayCircle,
  ChevronDown,
  ChevronUp
} from 'lucide-react';
import { sound } from '../utils/audio';
import { BarcodeDisplay } from './VisualCodes';
import { PackageScannerOCR } from './PackageScannerOCR';
import { ExtractedLabelData } from '../services/ocr-parser.service';
import { residentMatcherService, ResidentMatchResult } from '../services/resident-matcher.service';
import { shelfAllocatorService } from '../services/shelf-allocator.service';
import { storageService } from '../services/storage.service';

// Payload aceito por App.tsx: handleAddPackage (ver src/App.tsx)
export type PackageIntakePayload = Omit<PackageItem, 'id' | 'status' | 'receivedAt' | 'qrToken'> & {
  registeredVia?: 'PORTARIA' | 'TOTEM_ENTREGADOR';
  deliveryGuyName?: string;
};

interface PackageIntakeFlowProps {
  packages: PackageItem[];
  units: Unit[];
  onAddPackage: (pkg: PackageIntakePayload) => Promise<boolean>;
  onShowToast: (message: string, type?: 'success' | 'info' | 'warning') => void;
  /** Quem está usando este fluxo: porteiro logado (Portaria) ou quiosque do entregador (Totem). */
  registeredVia: 'PORTARIA' | 'TOTEM_ENTREGADOR';
  /** Nome gravado no log de auditoria. */
  operatorName: string;
  /** Só relevante pro Totem — identificação leve do entregador (sem conta de verdade). */
  deliveryGuyName?: string;
  onDeliveryGuyNameChange?: (name: string) => void;
  /** Disparado após o registro, além de onAddPackage — usado pelo Totem pra exibir o ticket. */
  onPackageRegistered?: (info: {
    block: string | number;
    apartment: number;
    residentName: string;
    carrier: Carrier;
    trackingCode: string;
    shelf: StorageLocation;
  }) => void;
}

/**
 * Fluxo de recepção automatizada por OCR — escaneia a etiqueta, reconhece transportadora,
 * rastreio, bloco/apto/morador (fuzzy match) e sugere a estante, com confirmação em 1 toque
 * (ou automática em 2s quando a confiança é alta). Compartilhado entre PortariaView (aba
 * Entrada) e TotemView (autoatendimento do entregador) — mesma automação, dois contextos.
 */
export const PackageIntakeFlow: React.FC<PackageIntakeFlowProps> = ({
  packages,
  units,
  onAddPackage,
  onShowToast,
  registeredVia,
  operatorName,
  deliveryGuyName,
  onDeliveryGuyNameChange,
  onPackageRegistered
}) => {
  // OCR RECEPTION AUTOMATION STATE
  const [isOcrScannerOpen, setIsOcrScannerOpen] = useState<boolean>(true);
  const [lastOcrResult, setLastOcrResult] = useState<ExtractedLabelData | null>(null);
  const [lastMatchResult, setLastMatchResult] = useState<ResidentMatchResult | null>(null);
  const [autoConfirmCountdown, setAutoConfirmCountdown] = useState<number | null>(null);
  const [isCountdownPaused, setIsCountdownPaused] = useState<boolean>(false);
  const [highlightedFallbackField, setHighlightedFallbackField] = useState<'tracking' | 'unit' | 'carrier' | null>(null);

  // FORM STATE
  const [trackingInput, setTrackingInput] = useState('');
  const [selectedUnit, setSelectedUnit] = useState<Unit | null>(null);
  const [unitSearchText, setUnitSearchText] = useState('');
  // Cadastro manual de bloco/apto quando o morador ainda não existe na base (sem limite de 360 unidades)
  const [manualBlock, setManualBlock] = useState('');
  const [manualApartment, setManualApartment] = useState('');
  const [manualResidentName, setManualResidentName] = useState('');
  const [selectedCarrier, setSelectedCarrier] = useState<Carrier>('Mercado Livre');
  const [selectedShelf, setSelectedShelf] = useState<ShelfLetter>('A');
  const [selectedLevel, setSelectedLevel] = useState<ShelfLevel>(1);
  const [notes, setNotes] = useState('');
  const [selectedPhoto, setSelectedPhoto] = useState<string>(SAMPLE_PACKAGE_PHOTOS[0]);
  const [isScanningSim, setIsScanningSim] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const isTotem = registeredVia === 'TOTEM_ENTREGADOR';

  // Autocomplete filtering for units
  const filteredUnits = useMemo(() => {
    if (!unitSearchText.trim()) return [];
    const query = unitSearchText.toLowerCase();
    return units
      .filter(u =>
        u.residentName.toLowerCase().includes(query) ||
        u.id.toLowerCase().includes(query) ||
        `bloco ${u.block}`.includes(query) ||
        `apt ${u.apartment}`.includes(query) ||
        `${u.block} ${u.apartment}`.includes(query)
      )
      .slice(0, 8);
  }, [unitSearchText, units]);

  // AUTO-CONFIRM COUNTDOWN EFFECT (2 seconds timer with audio ticks)
  useEffect(() => {
    if (autoConfirmCountdown === null || isCountdownPaused) return;

    if (autoConfirmCountdown <= 0) {
      handleExecuteAddPackage();
      setAutoConfirmCountdown(null);
      return;
    }

    const timer = setTimeout(() => {
      sound.playScanBeep();
      setAutoConfirmCountdown((prev) => (prev !== null ? prev - 1 : null));
    }, 1000);

    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoConfirmCountdown, isCountdownPaused]);

  // Handle OCR Scan Completion & Smart Matcher Pipeline
  const handleOcrScanComplete = (
    extracted: ExtractedLabelData,
    capturedPhotoUrl: string,
    preprocessedPhotoUrl?: string
  ) => {
    setLastOcrResult(extracted);
    setSelectedPhoto(capturedPhotoUrl);
    setSelectedCarrier(extracted.carrier);

    // 1. Calculate best storage slot using least-occupied algorithm
    const slotAllocation = shelfAllocatorService.allocateBestSlot(packages, extracted.carrier);
    setSelectedShelf(slotAllocation.shelf);
    setSelectedLevel(slotAllocation.level);

    // 2. Perform fuzzy & unit matching against Village Azaleia 360 units
    const match = residentMatcherService.matchResident(
      units,
      extracted.block,
      extracted.apartment,
      extracted.recipientName
    );
    setLastMatchResult(match);

    if (match.matchedUnit) {
      setSelectedUnit(match.matchedUnit);
    } else if (extracted.block && extracted.apartment) {
      // Unidade lida pelo OCR mas não cadastrada: preenche a busca para exibir o que foi lido
      setUnitSearchText(`Bloco ${extracted.block} Apt ${extracted.apartment}`);
    }

    if (extracted.trackingCode) {
      setTrackingInput(extracted.trackingCode);
    } else {
      // Missing tracking code triggers fallback
      setTrackingInput('');
      setHighlightedFallbackField('tracking');
    }

    if (extracted.notes) {
      setNotes(extracted.notes);
    }

    // 3. Evaluation for Auto-Confirmation vs Fallback Handling
    if (match.matchedUnit && extracted.trackingCode) {
      // Unidade localizada com precisão (bloco e apto batem com o condomínio)
      setHighlightedFallbackField(null);
      setIsCountdownPaused(false);
      setAutoConfirmCountdown(2);
      onShowToast(
        `✓ Reconhecimento OCR: Bloco ${match.matchedUnit.block} Apt ${match.matchedUnit.apartment} (${match.matchedUnit.residentName}) - Confirmação em 2s!`,
        'success'
      );
    } else {
      // EXCEPTION / FALLBACK CASE (Requires rapid 1-touch confirmation)
      setAutoConfirmCountdown(null);
      if (!match.matchedUnit) {
        setHighlightedFallbackField('unit');
        onShowToast('⚠️ OCR: Unidade não localizada no cadastro do condomínio.', 'warning');
      } else if (!extracted.trackingCode) {
        setHighlightedFallbackField('tracking');
        onShowToast('⚠️ OCR: Código de rastreio não localizado. Preencha ou confirme.', 'warning');
      }
    }
  };

  // Smart suggestion trigger
  const applySmartSuggestion = () => {
    const sug = getSmartShelfSuggestion(packages);
    setSelectedShelf(sug.shelf);
    setSelectedLevel(sug.level);
    sound.playScanBeep();
    onShowToast(`Sugestão Inteligente aplicada: Estante ${sug.shelf} - Prateleira ${sug.level}`, 'info');
  };

  // Generate random tracking code
  const generateRandomTracking = (carrier: Carrier) => {
    sound.playScanBeep();
    const randNum = Math.floor(100000000 + Math.random() * 900000000);
    let code = '';
    if (carrier === 'Mercado Livre') code = `ML-${randNum}BR`;
    else if (carrier === 'Amazon') code = `AMZ-BR-${Math.floor(10000000 + Math.random() * 90000000)}`;
    else if (carrier === 'Correios') code = `NL-${randNum}BR`;
    else if (carrier === 'Shopee') code = `SHP-${randNum}`;
    else if (carrier === 'Loggi') code = `LOG-${Math.floor(100000000 + Math.random() * 900000000)}`;
    else code = `TRK-${randNum}`;

    setTrackingInput(code);
  };

  // Simulate scanner read
  const handleSimulateScanner = () => {
    setIsScanningSim(true);
    sound.playScanBeep();
    setTimeout(() => {
      generateRandomTracking(selectedCarrier);
      setIsScanningSim(false);
      onShowToast('Código lido com sucesso pelo Scanner Barcode!', 'success');
    }, 600);
  };

  // Core Package Registration Execution
  const handleExecuteAddPackage = async () => {
    if (isSubmitting) return; // trava contra duplo clique/duplo toque
    if (!selectedUnit) {
      onShowToast('Selecione a Unidade/Morador de destino!', 'warning');
      return;
    }
    if (isTotem && !deliveryGuyName?.trim()) {
      onShowToast('Informe seu nome ou a transportadora antes de confirmar a entrega.', 'warning');
      return;
    }

    setIsSubmitting(true);
    try {
      const tracking = trackingInput.trim() || `PKG-${Date.now().toString().slice(-6)}`;
      const shelf: StorageLocation = { shelf: selectedShelf, level: selectedLevel };

      // Upload package photo to Supabase Storage Bucket
      let finalPhotoUrl = selectedPhoto;
      if (selectedPhoto && selectedPhoto.startsWith('data:')) {
        finalPhotoUrl = await storageService.uploadFile('packages', selectedPhoto);
      }

      // AGUARDA o resultado real do banco (BUG-004) — sem isso a tela afirmava
      // "registrada com sucesso" mesmo quando a gravacao falhava silenciosamente.
      const ok = await onAddPackage({
        trackingCode: tracking,
        unitId: selectedUnit.id,
        block: selectedUnit.block,
        apartment: selectedUnit.apartment,
        residentName: selectedUnit.residentName,
        carrier: selectedCarrier,
        shelf,
        photoUrl: finalPhotoUrl,
        notes: notes.trim() || (lastOcrResult ? `Recepção Automatizada OCR (${selectedCarrier})` : undefined),
        operatorName,
        registeredVia,
        deliveryGuyName: isTotem ? deliveryGuyName?.trim() : undefined
      });

      if (!ok) {
        onShowToast('Não foi possível salvar a encomenda no servidor. Verifique a conexão e tente novamente.', 'warning');
        return;
      }

      onPackageRegistered?.({
        block: selectedUnit.block,
        apartment: selectedUnit.apartment,
        residentName: selectedUnit.residentName,
        carrier: selectedCarrier,
        trackingCode: tracking,
        shelf
      });

      sound.playSuccess();
      onShowToast(
        `✓ Encomenda registrada para Bloco ${selectedUnit.block} Apt ${selectedUnit.apartment}! WhatsApp, E-mail e Push disparados em paralelo.`,
        'success'
      );

      // Reset state ready for next package
      setTrackingInput('');
      setSelectedUnit(null);
      setUnitSearchText('');
      setNotes('');
      setLastOcrResult(null);
      setLastMatchResult(null);
      setAutoConfirmCountdown(null);
      setHighlightedFallbackField(null);
      setSelectedPhoto(SAMPLE_PACKAGE_PHOTOS[Math.floor(Math.random() * SAMPLE_PACKAGE_PHOTOS.length)]);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleRegisterPackage = (e: React.FormEvent) => {
    e.preventDefault();
    handleExecuteAddPackage();
  };

  return (
    <div className="space-y-6">
      {/* Entregador self-identification (Totem only — sem conta real, só rastreabilidade leve) */}
      {isTotem && (
        <div className="bg-white rounded-2xl border border-[#D4AF37]/35 p-4 sm:p-5 shadow-md">
          <label className="block text-xs font-bold text-[#0D3823] uppercase tracking-wider mb-1.5">
            Identificação do Entregador / Transportadora *
          </label>
          <input
            type="text"
            value={deliveryGuyName || ''}
            onChange={(e) => onDeliveryGuyNameChange?.(e.target.value)}
            placeholder="Ex: Lucas Motoboy / Entregador Shopee"
            required
            className="w-full bg-[#F8F9FA] border border-slate-300 rounded-xl px-4 py-2.5 text-sm text-[#0D3823] font-semibold focus:outline-none focus:border-[#D81B60] focus:ring-2 focus:ring-[#D81B60]/20 shadow-inner"
          />
        </div>
      )}

      {/* 1. OCR RECEPTION BANNER & SCANNER COMPONENT */}
      <div className="bg-gradient-to-br from-[#061D12] via-[#0D3823] to-[#15462D] rounded-3xl border-2 border-[#D4AF37]/50 p-5 sm:p-7 text-white shadow-2xl relative overflow-hidden">
        {/* Ambient gold glow */}
        <div className="absolute top-0 right-0 w-80 h-80 bg-[#D4AF37]/10 rounded-full blur-3xl pointer-events-none" />

        <div className="relative z-10 space-y-5">
          {/* Header Bar */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-white/10 pb-4">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-[#D81B60] to-[#AD1457] flex items-center justify-center shadow-lg shadow-[#D81B60]/40 border border-[#FFF2B2]/40">
                <ScanLine className="w-6 h-6 text-[#FFF2B2] animate-pulse" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-[11px] font-black uppercase tracking-wider text-[#FFF2B2]">
                    Recepção Automatizada
                  </span>
                  <span className="px-2 py-0.5 rounded-full bg-[#D4AF37] text-[#0D3823] text-[10px] font-black uppercase shadow-xs">
                    Zero Digitação
                  </span>
                </div>
                <h3 className="text-lg sm:text-xl font-black text-white">
                  OCR Inteligente de Encomendas
                </h3>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  setIsOcrScannerOpen(!isOcrScannerOpen);
                  sound.playScanBeep();
                }}
                className="px-4 py-2 rounded-xl bg-white/10 hover:bg-white/20 text-slate-200 text-xs font-bold transition-all border border-white/15 flex items-center gap-2"
              >
                <Camera className="w-4 h-4 text-[#FFF2B2]" />
                <span>{isOcrScannerOpen ? 'Recolher Câmera' : 'Abrir Câmera OCR'}</span>
                {isOcrScannerOpen ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
              </button>
            </div>
          </div>

          {/* Collapsible Live OCR Scanner */}
          {isOcrScannerOpen && (
            <PackageScannerOCR
              onScanComplete={handleOcrScanComplete}
              onClose={() => setIsOcrScannerOpen(false)}
            />
          )}

          {/* 2. INSTANT SUCCESS CONFIRMATION CARD (SCORE >= 85%) */}
          {lastMatchResult?.isHighConfidence && selectedUnit && trackingInput && (
            <div className="bg-gradient-to-r from-[#0D3823] to-[#15462D] rounded-2xl border-2 border-[#D4AF37] p-5 sm:p-6 shadow-2xl space-y-4 animate-fadeIn">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-white/15 pb-3">
                <div className="flex items-center gap-2.5">
                  <div className="w-8 h-8 rounded-full bg-emerald-500/20 border border-emerald-400 flex items-center justify-center">
                    <CheckCircle2 className="w-5 h-5 text-emerald-400" />
                  </div>
                  <div>
                    <div className="text-xs font-bold uppercase tracking-wider text-[#FFF2B2]">
                      Reconhecimento 100% Concluído
                    </div>
                    <h4 className="text-base sm:text-lg font-black text-white">
                      Pronto para Entrada Imediata
                    </h4>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <span className="px-3 py-1 rounded-full bg-[#D4AF37] text-[#0D3823] text-xs font-black">
                    {lastMatchResult.confidenceScore}% Confiança OCR
                  </span>
                </div>
              </div>

              {/* Summary Grid */}
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3 text-xs">
                <div className="bg-black/30 p-3 rounded-xl border border-white/10 space-y-1">
                  <span className="text-[10px] text-slate-400 font-semibold uppercase">Morador & Unidade:</span>
                  <div className="font-extrabold text-white text-sm">
                    Bloco {selectedUnit.block} • Apt {selectedUnit.apartment}
                  </div>
                  <div className="text-emerald-300 font-medium truncate">
                    {selectedUnit.residentName}
                  </div>
                </div>

                <div className="bg-black/30 p-3 rounded-xl border border-white/10 space-y-1">
                  <span className="text-[10px] text-slate-400 font-semibold uppercase">Transportadora:</span>
                  <div className="font-extrabold text-white text-sm flex items-center gap-1.5">
                    <span>{CARRIER_CONFIG[selectedCarrier]?.icon}</span>
                    <span>{selectedCarrier}</span>
                  </div>
                  <div className="text-[#FFF2B2] font-mono text-[11px] truncate">
                    {trackingInput}
                  </div>
                </div>

                <div className="bg-black/30 p-3 rounded-xl border border-white/10 space-y-1">
                  <span className="text-[10px] text-slate-400 font-semibold uppercase">Vaga Otimizada:</span>
                  <div className="font-extrabold text-[#FFF2B2] text-sm flex items-center gap-1">
                    <MapPin className="w-3.5 h-3.5 text-[#D81B60]" />
                    <span>Estante {selectedShelf} • Nível {selectedLevel}</span>
                  </div>
                  <div className="text-slate-300 text-[10px]">
                    Menor índice de ocupação
                  </div>
                </div>

                <div className="bg-black/30 p-3 rounded-xl border border-white/10 space-y-1">
                  <span className="text-[10px] text-slate-400 font-semibold uppercase">Avisos em Paralelo:</span>
                  <div className="font-extrabold text-emerald-300 text-xs flex items-center gap-1">
                    <Zap className="w-3.5 h-3.5 text-[#D4AF37]" />
                    <span>WhatsApp + E-mail + Push</span>
                  </div>
                  <div className="text-slate-300 text-[10px]">
                    {selectedUnit.residentPhones?.length || 1} telefone(s) cadastrados
                  </div>
                </div>
              </div>

              {/* 2-Second Countdown Progress Bar & Actions */}
              <div className="bg-black/40 p-4 rounded-xl border border-white/15 space-y-3">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs">
                  <div className="flex items-center gap-2 text-slate-200 font-semibold">
                    <Clock className="w-4 h-4 text-[#D4AF37] animate-spin" />
                    <span>
                      {autoConfirmCountdown !== null && autoConfirmCountdown > 0
                        ? `Auto-confirmação e disparo em: ${autoConfirmCountdown}s...`
                        : 'Aguardando confirmação manual'}
                    </span>
                  </div>

                  <div className="flex items-center gap-2">
                    {autoConfirmCountdown !== null && (
                      <button
                        type="button"
                        onClick={() => {
                          setIsCountdownPaused(!isCountdownPaused);
                          sound.playScanBeep();
                        }}
                        className="px-3 py-1 rounded-lg bg-white/10 hover:bg-white/20 text-slate-300 text-xs font-semibold flex items-center gap-1.5 transition-colors"
                      >
                        {isCountdownPaused ? <PlayCircle className="w-3.5 h-3.5" /> : <PauseCircle className="w-3.5 h-3.5" />}
                        <span>{isCountdownPaused ? 'Retomar Countdown' : 'Pausar'}</span>
                      </button>
                    )}
                  </div>
                </div>

                {/* Progress indicator */}
                {autoConfirmCountdown !== null && !isCountdownPaused && (
                  <div className="w-full bg-white/20 h-2 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-gradient-to-r from-[#D4AF37] to-[#D81B60] transition-all duration-1000 ease-linear"
                      style={{ width: `${(autoConfirmCountdown / 2) * 100}%` }}
                    />
                  </div>
                )}

                {/* Big Action Buttons */}
                <div className="flex flex-col sm:flex-row gap-3 pt-1">
                  <button
                    type="button"
                    onClick={handleExecuteAddPackage}
                    disabled={isSubmitting}
                    className="flex-1 py-3.5 rounded-xl bg-gradient-to-r from-[#D81B60] via-[#E91E63] to-[#AD1457] hover:from-[#AD1457] hover:to-[#880E4F] text-white font-black text-sm shadow-xl shadow-[#D81B60]/40 border border-[#FFF2B2]/40 flex items-center justify-center gap-2 transition-all transform active:scale-98 disabled:opacity-60 disabled:cursor-not-allowed"
                  >
                    <CheckCircle2 className="w-5 h-5 text-[#FFF2B2]" />
                    <span>{isSubmitting ? 'Salvando...' : 'Confirmar Entrada Agora & Disparar Notificações'}</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setAutoConfirmCountdown(null);
                      sound.playScanBeep();
                    }}
                    className="px-4 py-3 rounded-xl bg-white/10 hover:bg-white/20 text-slate-200 font-bold text-xs border border-white/20 transition-colors"
                  >
                    Ajustar Campos no Formulário
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* 3. EXCEPTION / FALLBACK CARD (< 85% CONFIDENCE OR MISSING FIELD) */}
          {lastOcrResult && (!lastMatchResult?.isHighConfidence || !trackingInput) && (
            <div className="bg-amber-950/90 rounded-2xl border-2 border-amber-400 p-5 text-amber-50 shadow-2xl space-y-4 animate-fadeIn">
              <div className="flex items-start justify-between gap-3 border-b border-amber-500/30 pb-3">
                <div className="flex items-center gap-2.5">
                  <div className="w-9 h-9 rounded-xl bg-amber-500/20 border border-amber-400 flex items-center justify-center shrink-0">
                    <AlertCircle className="w-5 h-5 text-amber-300 animate-bounce" />
                  </div>
                  <div>
                    <div className="text-[11px] font-black uppercase tracking-wider text-amber-300">
                      Fallback Rápido de OCR • Confirmação Necessária
                    </div>
                    <h4 className="text-base font-bold text-white">
                      {!trackingInput
                        ? 'Código de rastreio não identificado na etiqueta'
                        : 'Confirme o morador ou unidade de destino'}
                    </h4>
                  </div>
                </div>

                <span className="px-2.5 py-1 rounded-full bg-amber-400/20 border border-amber-400/40 text-amber-200 text-xs font-bold">
                  Ação Manual Rápida
                </span>
              </div>

              <p className="text-xs text-amber-200 leading-relaxed">
                {!trackingInput
                  ? 'A etiqueta foi lida com sucesso, mas o código de barras ou numeração de rastreio estava ilegível. Escaneie com o leitor USB ou clique abaixo para gerar um código provisório.'
                  : 'O OCR extraiu o texto, mas a similaridade com a lista de moradores ficou abaixo de 85%. Selecione a unidade correta com 1 toque:'}
              </p>

              {/* 1-Touch Resolution Chips for Alternative Matches */}
              {lastMatchResult?.alternativeMatches && lastMatchResult.alternativeMatches.length > 0 && (
                <div className="space-y-2">
                  <div className="text-[11px] font-bold text-amber-300 uppercase">
                    Sugestões de Moradores Encontrados:
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {lastMatchResult.alternativeMatches.map((alt) => (
                      <button
                        key={alt.unit.id}
                        type="button"
                        onClick={() => {
                          setSelectedUnit(alt.unit);
                          sound.playScanBeep();
                          onShowToast(`Unidade selecionada: Bloco ${alt.unit.block} Apt ${alt.unit.apartment}`, 'success');
                        }}
                        className={`p-2.5 rounded-xl border text-left transition-all flex items-center justify-between text-xs ${
                          selectedUnit?.id === alt.unit.id
                            ? 'bg-amber-400 text-amber-950 font-bold border-white shadow-md'
                            : 'bg-black/30 hover:bg-black/50 text-amber-100 border-amber-500/40'
                        }`}
                      >
                        <div>
                          <div className="font-extrabold">
                            Bloco {alt.unit.block} • Apt {alt.unit.apartment}
                          </div>
                          <div className="text-[11px] opacity-90">{alt.unit.residentName}</div>
                        </div>
                        <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-500/30 text-amber-200 font-mono">
                          {alt.confidenceScore}% match
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Fallback tracking generator */}
              {!trackingInput && (
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <span className="text-xs text-amber-300 font-semibold">Solução rápida:</span>
                  <button
                    type="button"
                    onClick={() => generateRandomTracking(selectedCarrier)}
                    className="px-3 py-1.5 rounded-lg bg-amber-400 hover:bg-amber-300 text-amber-950 font-bold text-xs flex items-center gap-1.5 transition-colors shadow-sm"
                  >
                    <Zap className="w-3.5 h-3.5" />
                    <span>Gerar Código Automático {selectedCarrier}</span>
                  </button>
                </div>
              )}

              <div className="pt-2 flex flex-col sm:flex-row gap-2">
                <button
                  type="button"
                  onClick={handleExecuteAddPackage}
                  disabled={!selectedUnit || isSubmitting}
                  className="flex-1 py-3 rounded-xl bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-600 hover:to-amber-700 text-slate-950 font-black text-xs shadow-lg transition-all flex items-center justify-center gap-2 disabled:opacity-40"
                >
                  <Check className="w-4 h-4" />
                  <span>{isSubmitting ? 'Salvando...' : 'Confirmar Entrada com Dados Selecionados'}</span>
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 4. MAIN REGISTRATION FORM & LIVE REAL-TIME PREVIEW */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Main Form */}
        <div className="lg:col-span-8 bg-white rounded-2xl border border-[#D4AF37]/35 p-6 shadow-md space-y-6 text-[#1A2E22]">
          <div className="flex items-center justify-between border-b border-slate-100 pb-4">
            <div>
              <h3 className="text-lg font-extrabold text-[#0D3823] flex items-center gap-2">
                <span>Dados do Pacote & Destinatário</span>
              </h3>
              <p className="text-xs text-slate-500">
                Campos preenchidos automaticamente pelo OCR ou editáveis manualmente
              </p>
            </div>
            <span className="text-xs px-2.5 py-1 rounded-full bg-[#E8F5E9] text-[#0D3823] font-bold border border-[#A5D6A7]">
              360 Unidades cadastradas
            </span>
          </div>

          <form onSubmit={handleRegisterPackage} className="space-y-5">
            {/* 1. Barcode & Carrier Selection */}
            <div className={`space-y-3 p-3.5 rounded-2xl transition-all ${
              highlightedFallbackField === 'tracking' ? 'bg-amber-50 border-2 border-amber-400' : ''
            }`}>
              <label className="block text-xs font-bold text-[#0D3823] uppercase tracking-wider">
                1. Transportadora & Código de Rastreio
              </label>

              {/* Carrier pills */}
              <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
                {(['Mercado Livre', 'Amazon', 'Correios', 'Shopee', 'Loggi', 'Outra'] as Carrier[]).map((c) => {
                  const cfg = CARRIER_CONFIG[c];
                  const isSelected = selectedCarrier === c;
                  return (
                    <button
                      key={c}
                      type="button"
                      onClick={() => {
                        setSelectedCarrier(c);
                        generateRandomTracking(c);
                      }}
                      className={`p-2.5 rounded-xl border text-center transition-all flex flex-col items-center gap-1 text-xs font-semibold ${
                        isSelected
                          ? 'bg-[#FCE4EC] border-[#D81B60] text-[#AD1457] ring-2 ring-[#D81B60]/30 shadow-sm'
                          : 'bg-[#F8F9FA] border-slate-200 text-slate-600 hover:border-[#D4AF37]/60 hover:bg-slate-50'
                      }`}
                    >
                      <span className="text-lg">{cfg.icon}</span>
                      <span className="truncate w-full">{c}</span>
                    </button>
                  );
                })}
              </div>

              {/* Tracking code input + Scan Button */}
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <input
                    type="text"
                    value={trackingInput}
                    onChange={(e) => setTrackingInput(e.target.value)}
                    placeholder="Ex: ML-894720194BR ou NL-928374102BR"
                    className="w-full bg-[#F8F9FA] border border-slate-300 rounded-xl px-3.5 py-2.5 text-sm text-[#0D3823] font-bold placeholder-slate-400 focus:outline-none focus:border-[#D81B60] focus:ring-2 focus:ring-[#D81B60]/20 font-mono shadow-inner"
                  />
                </div>

                <button
                  type="button"
                  onClick={handleSimulateScanner}
                  disabled={isScanningSim}
                  className="px-4 py-2.5 rounded-xl bg-[#0D3823] hover:bg-[#15462D] text-white font-semibold text-xs transition-colors flex items-center gap-2 border border-[#D4AF37]/40 shrink-0 shadow-sm"
                >
                  <RefreshCw className={`w-4 h-4 text-[#D4AF37] ${isScanningSim ? 'animate-spin' : ''}`} />
                  <span>{isScanningSim ? 'Lendo...' : 'Simular Barcode'}</span>
                </button>
              </div>
            </div>

            {/* 2. Destination Unit Search / Autocomplete */}
            <div className={`space-y-3 p-3.5 rounded-2xl transition-all ${
              highlightedFallbackField === 'unit' ? 'bg-amber-50 border-2 border-amber-400' : ''
            }`}>
              <label className="block text-xs font-bold text-[#0D3823] uppercase tracking-wider">
                2. Unidade Destino & Contatos da Família
              </label>

              {selectedUnit ? (
                <div className="p-4 rounded-2xl bg-[#E8F5E9] border-2 border-[#A5D6A7] space-y-3 shadow-sm">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-start gap-3">
                      <div className="w-11 h-11 rounded-xl bg-[#0D3823] text-[#FFF2B2] border border-[#D4AF37]/50 flex items-center justify-center font-black text-sm shadow-sm shrink-0">
                        B{selectedUnit.block}
                      </div>
                      <div>
                        <div className="text-[#0D3823] font-black text-sm sm:text-base">
                          Bloco {selectedUnit.block} — Apartamento {selectedUnit.apartment}
                        </div>
                        <div className="text-xs text-emerald-900 font-bold flex items-center gap-1.5 mt-0.5">
                          <User className="w-3.5 h-3.5 text-[#D81B60]" />
                          <span>Titular: {selectedUnit.residentName}</span>
                        </div>
                        <div className="text-[11px] text-slate-600 font-medium flex items-center gap-1.5 mt-0.5">
                          <span className="text-slate-500">E-mail:</span>
                          <span className="font-semibold text-slate-800">{selectedUnit.residentEmail || 'morador@email.com'}</span>
                        </div>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedUnit(null);
                        setUnitSearchText('');
                      }}
                      className="text-xs font-bold text-[#AD1457] hover:text-[#880E4F] px-3 py-1.5 rounded-xl bg-white border border-[#F48FB1] shadow-sm shrink-0"
                    >
                      Trocar Unidade
                    </button>
                  </div>

                  {/* Multichannel Notification Delivery Pre-Check */}
                  <div className="pt-2 border-t border-[#A5D6A7]/60 space-y-2">
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="font-bold text-[#0D3823] flex items-center gap-1">
                        <span>Disparo Multicanal Automático ao Registrar:</span>
                      </span>
                      <span className="text-[10px] px-2 py-0.5 rounded-full bg-[#0D3823] text-[#FFF2B2] font-extrabold">
                        3 Canais Integrados
                      </span>
                    </div>

                    {/* WhatsApp Family Contacts */}
                    <div className="flex flex-wrap gap-1.5">
                      {(selectedUnit.residentPhones && selectedUnit.residentPhones.length > 0
                        ? selectedUnit.residentPhones
                        : [{ id: 'p1', label: 'Titular', number: selectedUnit.residentPhone || '(11) 98765-4321', isWhatsapp: true }]
                      ).map((phone, pIdx) => (
                        <span
                          key={phone.id || pIdx}
                          className="inline-flex items-center gap-1 text-[10px] font-mono font-bold bg-white text-[#0D3823] px-2 py-1 rounded-lg border border-[#A5D6A7] shadow-2xs"
                        >
                          <span className="text-[9px] px-1 py-0.2 bg-emerald-100 text-emerald-800 rounded font-sans font-extrabold uppercase">
                            {phone.label}
                          </span>
                          <span>{phone.number}</span>
                        </span>
                      ))}
                    </div>

                    <div className="flex items-center gap-2 text-[10px] text-emerald-800 font-medium">
                      <span className="inline-flex items-center gap-1 bg-emerald-100/80 px-2 py-0.5 rounded text-emerald-900 font-bold">
                        ✓ Evolution WhatsApp ({selectedUnit.residentPhones?.length || 1})
                      </span>
                      <span className="inline-flex items-center gap-1 bg-pink-100/80 px-2 py-0.5 rounded text-pink-900 font-bold">
                        ✓ Resend E-mail
                      </span>
                      <span className="inline-flex items-center gap-1 bg-amber-100/80 px-2 py-0.5 rounded text-amber-900 font-bold">
                        ✓ Notificação no App
                      </span>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="relative">
                  <div className="relative">
                    <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-3" />
                    <input
                      type="text"
                      value={unitSearchText}
                      onChange={(e) => setUnitSearchText(e.target.value)}
                      placeholder="Digite o apto (ex: 102), bloco (ex: Bloco 3) ou nome do morador..."
                      className="w-full bg-[#F8F9FA] border border-slate-300 rounded-xl pl-10 pr-4 py-2.5 text-sm text-[#0D3823] placeholder-slate-400 focus:outline-none focus:border-[#D81B60] focus:ring-2 focus:ring-[#D81B60]/20 shadow-inner"
                    />
                  </div>

                  {/* Autocomplete dropdown */}
                  {filteredUnits.length > 0 && (
                    <div className="absolute left-0 right-0 top-full mt-1 bg-white border border-[#D4AF37]/40 rounded-xl shadow-2xl z-30 max-h-56 overflow-y-auto divide-y divide-slate-100">
                      {filteredUnits.map((u) => (
                        <button
                          key={u.id}
                          type="button"
                          onClick={() => {
                            setSelectedUnit(u);
                            setUnitSearchText('');
                            sound.playScanBeep();
                          }}
                          className="w-full px-4 py-2.5 text-left hover:bg-[#FCE4EC]/50 transition-colors flex items-center justify-between text-xs"
                        >
                          <div className="flex items-center gap-2">
                            <span className="font-extrabold text-[#AD1457] bg-[#FCE4EC] px-2 py-0.5 rounded border border-[#F48FB1]">
                              Bloco {u.block} - Apt {u.apartment}
                            </span>
                            <span className="text-[#0D3823] font-bold">{u.residentName}</span>
                          </div>
                          <span className="text-slate-500 font-medium">
                            {u.residentPhones?.length || 1} tel(s) cadastrado(s)
                          </span>
                        </button>
                      ))}
                    </div>
                  )}

                  {/* Nenhum morador ainda cadastrado pra este bloco/apto — condomínio não tem limite fixo
                      de unidades, então permite registrar a encomenda mesmo assim, digitando na mão. */}
                  {unitSearchText.trim() !== '' && filteredUnits.length === 0 && (
                    <div className="mt-3 p-4 rounded-2xl bg-amber-50 border border-amber-300 space-y-3">
                      <div className="flex items-center gap-2 text-amber-800 text-xs font-bold">
                        <AlertCircle className="w-4 h-4 shrink-0" />
                        <span>Morador ainda não cadastrado. Registre a encomenda mesmo assim:</span>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <input
                          type="text"
                          value={manualBlock}
                          onChange={(e) => setManualBlock(e.target.value)}
                          placeholder="Bloco (ex: 3 ou 12B)"
                          className="bg-white border border-amber-300 rounded-lg px-3 py-2 text-xs text-[#0D3823] font-bold focus:outline-none focus:border-[#D81B60]"
                        />
                        <input
                          type="number"
                          inputMode="numeric"
                          value={manualApartment}
                          onChange={(e) => setManualApartment(e.target.value)}
                          placeholder="Apartamento"
                          className="bg-white border border-amber-300 rounded-lg px-3 py-2 text-xs text-[#0D3823] font-bold focus:outline-none focus:border-[#D81B60]"
                        />
                      </div>
                      <input
                        type="text"
                        value={manualResidentName}
                        onChange={(e) => setManualResidentName(e.target.value)}
                        placeholder="Nome do morador (opcional por enquanto)"
                        className="w-full bg-white border border-amber-300 rounded-lg px-3 py-2 text-xs text-[#0D3823] font-semibold focus:outline-none focus:border-[#D81B60]"
                      />
                      <button
                        type="button"
                        onClick={() => {
                          const block = manualBlock.trim();
                          const apartment = parseInt(manualApartment, 10);
                          if (!block || !apartment) {
                            onShowToast('Informe o Bloco e o Apartamento.', 'warning');
                            return;
                          }
                          const residentName = manualResidentName.trim() || `Morador Bloco ${block} Apto ${apartment}`;
                          setSelectedUnit({
                            id: `B${String(block).padStart(2, '0')}-A${apartment}`,
                            block,
                            apartment,
                            residentName,
                            residentPhone: '',
                            residentPhones: [],
                            residentEmail: ''
                          });
                          setUnitSearchText('');
                          setManualBlock('');
                          setManualApartment('');
                          setManualResidentName('');
                          sound.playScanBeep();
                        }}
                        className="w-full py-2 rounded-lg bg-[#0D3823] hover:bg-[#15462D] text-white text-xs font-bold transition-colors"
                      >
                        Usar este Bloco/Apartamento
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* 3. Storage Location & Smart Recommendation */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <label className="block text-xs font-bold text-[#0D3823] uppercase tracking-wider">
                  3. Local de Guarda Física (Estante & Prateleira)
                </label>
                <button
                  type="button"
                  onClick={applySmartSuggestion}
                  className="text-xs text-[#D81B60] hover:text-[#AD1457] flex items-center gap-1 font-extrabold hover:underline"
                >
                  <Sparkles className="w-3.5 h-3.5 text-[#D4AF37]" />
                  <span>Sugerir Espaço Vago</span>
                </button>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] text-slate-500 font-semibold mb-1">Estante</label>
                  <div className="grid grid-cols-3 gap-2">
                    {(['A', 'B', 'C'] as ShelfLetter[]).map((s) => (
                      <button
                        key={s}
                        type="button"
                        onClick={() => setSelectedShelf(s)}
                        className={`py-2 rounded-xl border text-xs font-extrabold transition-all ${
                          selectedShelf === s
                            ? 'bg-[#0D3823] border-[#D4AF37] text-white shadow-sm ring-2 ring-[#D4AF37]/30'
                            : 'bg-[#F8F9FA] border-slate-200 text-slate-700 hover:bg-slate-100'
                        }`}
                      >
                        Estante {s}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <label className="block text-[11px] text-slate-500 font-semibold mb-1">Prateleira / Nível</label>
                  <div className="grid grid-cols-4 gap-2">
                    {([1, 2, 3, 4] as ShelfLevel[]).map((lvl) => (
                      <button
                        key={lvl}
                        type="button"
                        onClick={() => setSelectedLevel(lvl)}
                        className={`py-2 rounded-xl border text-xs font-extrabold transition-all ${
                          selectedLevel === lvl
                            ? 'bg-[#0D3823] border-[#D4AF37] text-white shadow-sm ring-2 ring-[#D4AF37]/30'
                            : 'bg-[#F8F9FA] border-slate-200 text-slate-700 hover:bg-slate-100'
                        }`}
                      >
                        Nível {lvl}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div className="p-2.5 rounded-xl bg-[#E8F5E9] border border-[#A5D6A7] text-xs text-[#0D3823] flex items-center gap-2 font-medium">
                <MapPin className="w-4 h-4 text-[#D81B60] shrink-0" />
                <span>
                  Local Selecionado:{' '}
                  <strong className="text-[#0D3823] font-extrabold">Estante {selectedShelf} — Prateleira {selectedLevel}</strong>
                </span>
              </div>
            </div>

            {/* 4. Photo Simulator & Notes */}
            <div className="space-y-3">
              <label className="block text-xs font-bold text-[#0D3823] uppercase tracking-wider">
                4. Registro Fotográfico & Observações
              </label>

              <div className="flex flex-col sm:flex-row gap-4 items-start">
                <div className="relative group rounded-xl overflow-hidden border border-[#D4AF37]/40 w-32 h-24 shrink-0 bg-slate-100 shadow-sm">
                  <img
                    src={selectedPhoto}
                    alt="Foto Encomenda"
                    className="w-full h-full object-cover"
                    referrerPolicy="no-referrer"
                  />
                  <div className="absolute inset-0 bg-[#061D12]/70 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center p-1 text-center">
                    <span className="text-[10px] text-white font-semibold">Foto anexada</span>
                  </div>
                </div>

                <div className="flex-1 space-y-2 w-full">
                  <div className="flex flex-wrap gap-1.5 items-center">
                    <span className="text-[11px] text-slate-500 font-medium">Fotos de exemplo:</span>
                    {SAMPLE_PACKAGE_PHOTOS.map((photo, i) => (
                      <button
                        key={i}
                        type="button"
                        onClick={() => setSelectedPhoto(photo)}
                        className={`w-8 h-8 rounded-lg border overflow-hidden transition-all ${
                          selectedPhoto === photo ? 'border-[#D81B60] ring-2 ring-[#D81B60]/40' : 'border-slate-300 opacity-60 hover:opacity-100'
                        }`}
                      >
                        <img src={photo} alt={`preset ${i}`} className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                      </button>
                    ))}
                  </div>

                  <input
                    type="text"
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="Observações adicionais (ex: Frágil, caixa volumosa, envelope)..."
                    className="w-full bg-[#F8F9FA] border border-slate-300 rounded-xl px-3 py-2 text-xs text-[#0D3823] placeholder-slate-400 focus:outline-none focus:border-[#D81B60]"
                  />
                </div>
              </div>
            </div>

            {/* Submit Button in Official Rosa Azaleia */}
            <button
              type="submit"
              className="w-full py-3.5 rounded-xl bg-gradient-to-r from-[#D81B60] via-[#E91E63] to-[#AD1457] hover:from-[#AD1457] hover:to-[#880E4F] text-white font-extrabold text-sm shadow-lg shadow-[#D81B60]/30 transition-all flex items-center justify-center gap-2 transform active:scale-[0.99] border border-[#FFF2B2]/30"
            >
              <CheckCircle2 className="w-5 h-5 text-[#FFF2B2]" />
              <span>Registrar Encomenda & Notificar Morador</span>
            </button>
          </form>
        </div>

        {/* Quick Info & Live Preview side card */}
        <div className="lg:col-span-4 space-y-4">
          <div className="bg-white rounded-2xl border border-[#D4AF37]/35 p-5 shadow-md space-y-4">
            <h4 className="text-sm font-extrabold text-[#0D3823] flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-[#D4AF37]" />
              <span>Etiqueta Gerada em Tempo Real</span>
            </h4>

            <div className="bg-[#F8F9FA] p-4 rounded-xl border border-slate-200 text-slate-900 shadow-sm space-y-3 font-sans">
              <div className="flex items-center justify-between border-b border-slate-200 pb-2">
                <div className="font-extrabold text-[11px] text-[#0D3823] tracking-wider uppercase">
                  Village Azaleia • {isTotem ? 'Totem Entregador' : 'Portaria'}
                </div>
                <span className="text-[10px] font-mono font-bold bg-[#FCE4EC] text-[#AD1457] px-1.5 py-0.5 rounded border border-[#F48FB1]">
                  {selectedCarrier}
                </span>
              </div>

              <div className="space-y-1">
                <div className="text-[10px] text-slate-500 font-semibold uppercase">Destinatário:</div>
                <div className="font-extrabold text-sm text-[#0D3823]">
                  {selectedUnit ? selectedUnit.residentName : 'Aguardando seleção...'}
                </div>
                <div className="text-xs text-slate-700 font-semibold">
                  {selectedUnit ? `Bloco ${selectedUnit.block} • Apartamento ${selectedUnit.apartment}` : 'Selecione a unidade'}
                </div>
              </div>

              <div className="pt-2 border-t border-slate-200 flex items-center justify-between text-xs">
                <div className="text-slate-600">
                  Guarda: <strong className="text-[#0D3823]">Estante {selectedShelf}-{selectedLevel}</strong>
                </div>
                <div className="text-emerald-700 font-bold">
                  Status: Recebida
                </div>
              </div>

              {/* Visual Barcode Component */}
              <div className="pt-2 border-t border-slate-200">
                <BarcodeDisplay
                  value={trackingInput || 'ML-894720194BR'}
                />
              </div>
            </div>
          </div>

          {/* Status and Guide */}
          <div className="bg-[#0D3823] text-white rounded-2xl border border-[#D4AF37]/40 p-4 shadow-md space-y-3">
            <div className="flex items-center gap-2 text-xs font-bold text-[#FFF2B2]">
              <Shield className="w-4 h-4 text-[#D4AF37]" />
              <span>Protocolo LGPD & Segurança</span>
            </div>
            <p className="text-xs text-emerald-100/90 leading-relaxed">
              Ao confirmar a entrada, o sistema gera o QR Code único criptografado e dispara notificações instantâneas no WhatsApp (Evolution API), E-mail (Resend) e Web Push do morador.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};
