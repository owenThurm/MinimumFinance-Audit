const { expect } = require("chai");
const { ethers } = require("hardhat");
const {
  beforeHook,
  beforeEachHook,
  minimizeBondPeriod,
  timeTravelBlocks,
  forceFHMBondMinimumPositive,
  forceFHMBondNegative,
  forceHighMaxDebt,
} = require("../../../utils/testUtils.ts");
const { addressBook } = require("blockchain-addressbook");
const {
  FHM,
  FHM_STAKER,
  STAKED_FHM,
  FHM_STAKE_MANAGER,
  FHM_DAI_PAIR,
  BOGUS_ADDR_1,
  BOGUS_ADDR_2,
  TEST_TIMEOUT,
  FHM_DAI_BOND,
  FHM_DAI_ROUTE,
  FHM_WFTM_BOND,
  FHM_WFTM_ROUTE,
  FHM_DAI_LP_BOND,
  SLOW_TEST_FLAG,
  FANTOHM_TEST_FLAG,
  FHM_BOND_CALCULATOR,
  FHM_WHALES,
  FHM_TREASURY,
} = require("../../../constants.js");

const { spookyswap } = addressBook.fantom.platforms;
const devAddress = BOGUS_ADDR_2;

const contractNames = {
  vault: "MinimumVault",
  strategy: "StrategyFantOHM",
};

const vaultConfig = {
  name: "Minimum FantOHM",
  symbol: "minFHM",
  stratApprovalDelay: 21600,
  wantCap: ethers.utils.parseUnits("6000", 9),
};

const stratConfig = {
  rebaseStaker: FHM_STAKER,
  stakeManager: FHM_STAKE_MANAGER,
  keeper: BOGUS_ADDR_1,
  unirouter: spookyswap.router,
  serviceFeeRecipient: devAddress,
  minDeposit: 100,
  discordLink: "https://discord.gg/fS5ZUwDtVK",
};

describe(FANTOHM_TEST_FLAG + " Strategy rebaseBonded", function () {
  let vault,
    strategy,
    unirouter,
    fhm,
    stakedFhm,
    deployer,
    keeper,
    other,
    whale,
    daiBondDepository,
    wftmBondDepository,
    fhmDaiBondDepository,
    lpBondCalculator,
    stakeManager,
    stakingHelper,
    daiWftmPair,
    rebaseTokenBalStart,
    daiValueInitial,
    treasury,
    unirouterData;

  this.slow(20000);

  before(async () => {
    ({
      rebaseToken: fhm,
      stakedRebaseToken: stakedFhm,
      unirouter,
      unirouterData,
      whale,
      daiBondDepository,
      wftmBondDepository,
      daiLPBondDepository: fhmDaiBondDepository,
      lpBondCalculator,
      daiWftmPair,
      stakeManager,
      treasury,
      stakingHelper,
    } = await beforeHook({
      provider: ethers.provider,
      stratConfig,
      rebaseTokenAddr: FHM,
      stakedRebaseTokenAddr: STAKED_FHM,
      daiBondAddr: FHM_DAI_BOND,
      wftmBondAddr: FHM_WFTM_BOND,
      daiLPBondAddr: FHM_DAI_LP_BOND,
      lpBondCalculatorAddr: FHM_BOND_CALCULATOR,
      stakeManagerAddr: FHM_STAKE_MANAGER,
      whales: FHM_WHALES,
      whaleToken: STAKED_FHM,
      treasuryAddr: FHM_TREASURY,
      fundStaked: true,
      stakingHelperAddr: FHM_STAKER,
    }));
  });

  beforeEach(async () => {
    ({
      vault,
      strategy,
      rebaseTokenBalStart,
      daiValueInitial,
      deployer,
      keeper,
      other,
    } = await beforeEachHook({
      contractNames,
      vaultConfig,
      stratConfig,
      unirouter,
      rebaseToken: fhm,
      whale,
      stakedRebaseToken: stakedFhm,
      fundStaked: true,
    }));
    await forceHighMaxDebt(ethers.provider, daiBondDepository);
    await forceHighMaxDebt(ethers.provider, wftmBondDepository);
    await forceHighMaxDebt(ethers.provider, fhmDaiBondDepository);
  });

  it("When just staking, rebaseBonded should be 0", async function () {
    await vault.depositAll();
    expect(await strategy.isBonding()).to.equal(await vault.isBonding()).to.be
      .false;

    expect(await stakedFhm.balanceOf(strategy.address))
      .to.equal(await strategy.totalBalance())
      .to.equal(await strategy.stakedRebasing())
      .to.equal(await vault.balance());

    expect(await strategy.rebaseBonded()).to.equal(0);
  }).timeout(TEST_TIMEOUT);

  it("When just bonded all, rebaseBonded should be totalBalance (includes bond gains)", async function () {
    await vault.depositAll();
    expect(await strategy.isBonding()).to.equal(await vault.isBonding()).to.be
      .false;

    expect(await stakedFhm.balanceOf(strategy.address))
      .to.equal(await strategy.totalBalance())
      .to.equal(await strategy.stakedRebasing())
      .to.equal(await vault.balance());

    await strategy.addBond(FHM_DAI_BOND);
    await strategy.stakeToBondSingleAll(FHM_DAI_BOND, FHM_DAI_ROUTE);

    expect(await stakedFhm.balanceOf(strategy.address))
      .to.equal(await strategy.stakedRebasing())
      .to.equal(await strategy.totalRebasing())
      .to.equal(0);
    expect(await vault.balance())
      .to.equal(await strategy.totalBalance())
      .to.equal(await strategy.rebaseBonded());

    // gains immediately realized
    expect(await vault.balance()).to.gt(rebaseTokenBalStart);
  }).timeout(TEST_TIMEOUT);

  it("Just bonded all add unstaked, rebaseBonded should be totalBalance - unstaked", async function () {
    await vault.depositAll();
    expect(await strategy.isBonding()).to.equal(await vault.isBonding()).to.be
      .false;

    expect(await stakedFhm.balanceOf(strategy.address))
      .to.equal(await strategy.totalBalance())
      .to.equal(await strategy.stakedRebasing())
      .to.equal(await vault.balance());

    await strategy.addBond(FHM_DAI_BOND);
    await strategy.stakeToBondSingleAll(FHM_DAI_BOND, FHM_DAI_ROUTE);

    const bondDetails = await daiBondDepository.bondInfo(strategy.address);

    expect(await stakedFhm.balanceOf(strategy.address))
      .to.equal(await strategy.stakedRebasing())
      .to.equal(await strategy.totalRebasing())
      .to.equal(0);
    expect(await vault.balance())
      .to.equal(await strategy.totalBalance())
      .to.equal(await strategy.rebaseBonded());

    await vault.connect(whale).deposit(rebaseTokenBalStart);
    await strategy.unstakeAll();

    expect(await vault.balance())
      .to.eq(
        (await strategy.unstakedRebasing()).add(await strategy.rebaseBonded())
      )
      .to.eq(rebaseTokenBalStart.add(bondDetails.payout));
    expect(await strategy.rebaseBonded()).to.eq(bondDetails.payout);
    expect(await strategy.unstakedRebasing()).to.eq(rebaseTokenBalStart);
  }).timeout(TEST_TIMEOUT);

  it("Before bonding add unstaked, rebaseBonded should be totalBalance (DAI bond)", async function () {
    await vault.depositAll();
    expect(await strategy.isBonding()).to.equal(await vault.isBonding()).to.be
      .false;

    expect(await stakedFhm.balanceOf(strategy.address))
      .to.equal(await strategy.totalBalance())
      .to.equal(await strategy.stakedRebasing())
      .to.equal(await vault.balance());

    await strategy.unstake(rebaseTokenBalStart.div(2));

    await strategy.addBond(FHM_DAI_BOND);
    await strategy.stakeToBondSingleAll(FHM_DAI_BOND, FHM_DAI_ROUTE);

    expect(await stakedFhm.balanceOf(strategy.address))
      .to.equal(await strategy.stakedRebasing())
      .to.equal(await strategy.totalRebasing())
      .to.equal(0);
    expect(await vault.balance())
      .to.equal(await strategy.totalBalance())
      .to.equal(await strategy.rebaseBonded());
  }).timeout(TEST_TIMEOUT);
});
